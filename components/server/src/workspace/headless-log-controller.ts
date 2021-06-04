/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { inject, injectable } from "inversify";
import * as express from 'express';
import { User } from "@gitpod/gitpod-protocol";
import { log } from '@gitpod/gitpod-protocol/lib/util/logging';
import { CompositeResourceAccessGuard, OwnerResourceGuard, WorkspaceLogAccessGuard } from "../auth/resource-access";
import { HostContextProvider } from "../auth/host-context-provider";
import { DBWithTracing, TracedWorkspaceDB } from "@gitpod/gitpod-db/lib/traced-db";
import { WorkspaceDB } from "@gitpod/gitpod-db/lib/workspace-db";
import { Timeout, WorkspaceLogService } from "./workspace-log-service";
import * as opentracing from 'opentracing';
import { asyncHandler } from "../express-util";


@injectable()
export class HeadlessLogController {

    @inject(HostContextProvider) protected readonly hostContextProvider: HostContextProvider;
    @inject(TracedWorkspaceDB) protected readonly workspaceDb: DBWithTracing<WorkspaceDB>;
    @inject(WorkspaceLogService) protected readonly workspaceLogService: WorkspaceLogService;

    get apiRouter(): express.Router {
        const router = express.Router();

        router.get("/:instanceId/:terminalId", asyncHandler(async (req: express.Request, res: express.Response) => {
            const span = opentracing.globalTracer().startSpan("/headless-logs/");
            const params = { instanceId: req.params.instanceId, terminalId: req.params.terminalId };
            if (!req.isAuthenticated() || !User.is(req.user)) {
                res.sendStatus(401);
                log.warn("unauthenticated headless log request", params);
                return;
            }

            const user = req.user as User;
            if (user.blocked) {
                res.sendStatus(403);
                log.warn("blocked user attempted to fetch workspace cookie", { ...params, userId: user.id });
                return;
            }

            const instanceId = params.instanceId;
            const [workspace, instance] = await Promise.all([
                this.workspaceDb.trace({span}).findByInstanceId(instanceId),
                this.workspaceDb.trace({span}).findInstanceById(instanceId),
            ]);
            if (!workspace) {
                res.sendStatus(404);
                log.warn(`workspace for instanceId ${instanceId} not found`);
                return;
            }
            if (!instance) {
                res.sendStatus(404);
                log.warn(`instance ${instanceId} not found`);
                return;
            }
            const logCtx = { instanceId, workspaceId: workspace.id };

            try {
                // [gpl] It's a bit sad that we have to duplicate this access check... but that's due to the way our API code is written
                const resourceGuard = new CompositeResourceAccessGuard([
                    new OwnerResourceGuard(user.id),
                    new WorkspaceLogAccessGuard(() => Promise.resolve(user), this.hostContextProvider),
                ]);
                if (!await resourceGuard.canAccess({ kind: 'workspaceLog', subject: workspace }, 'get')) {
                    res.sendStatus(403);
                    log.warn(logCtx, "unauthenticated headless log access");
                    return;
                }

                res.setHeader('Content-Type', 'text/html; charset=utf-8');  // is text/plain, but with that node.js won't stream...
                res.setHeader('Transfer-Encoding', 'chunked');

                const writeToResponse = async (chunk: string) => new Promise<void>((resolve, reject) => {
                    res.write(chunk, "utf-8", (err?: Error | null) => {
                        if (err) {
                            reject(err);    // propagate write error to upstream
                        } else {
                            resolve();  // using a promise here to make backpressure work
                        }
                    });
                });
                const result = await this.workspaceLogService.streamWorkspaceLog(instance, params.terminalId, writeToResponse);
                if (Timeout.is(result)) {
                    res.sendStatus(408);    // request timeout
                    return;
                }
                res.end();
            } catch (err) {
                log.error(logCtx, "error streaming headless logs", err);
                res.end();
            }
        }));
        return router;
    }
}
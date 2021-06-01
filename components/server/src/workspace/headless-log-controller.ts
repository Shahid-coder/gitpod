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
import { WorkspaceLogService } from "./workspace-log-service";
import * as opentracing from 'opentracing';
import { asyncHandler } from "../express-util";


@injectable()
export class HeadlessLogController {

    @inject(HostContextProvider) protected readonly hostContextProvider: HostContextProvider;
    @inject(TracedWorkspaceDB) protected readonly workspaceDb: DBWithTracing<WorkspaceDB>;
    @inject(WorkspaceLogService) protected readonly workspaceLogService: WorkspaceLogService;

    get apiRouter(): express.Router {
        const router = express.Router();

        router.get("/:workspaceId/:terminalId", asyncHandler(async (req: express.Request, res: express.Response) => {
            const span = opentracing.globalTracer().startSpan("/headless-logs/");
            const params = { workspaceId: req.params.workspaceId, terminalId: req.params.terminalId };
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

            const workspaceId = params.workspaceId;
            const [workspace, instance] = await Promise.all([
                this.workspaceDb.trace({span}).findById(workspaceId),
                this.workspaceDb.trace({span}).findCurrentInstance(workspaceId),
            ]);
            if (!workspace) {
                res.sendStatus(404);
                log.warn(`workspace ${workspaceId} not found`);
                return;
            }
            if (!instance) {
                res.sendStatus(404);
                log.warn(`current instance for ${workspaceId} not found`);
                return;
            }
            const instanceId = instance.id;
            const logCtx = { instanceId, workspaceId };

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

                const workspaceLog = await this.workspaceLogService.getWorkspaceLog(instance, params.terminalId);
                if (!workspaceLog) {
                    res.sendStatus(404);
                    return;
                }

                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Transfer-Encoding', 'chunked');

                await new Promise<void>((resolve, reject) => {
                    const { stream } = workspaceLog;
                    stream.forEach((c) => new Promise<void>((resolve, reject) => {
                        res.write(c, "utf-8", (err?: Error | null) => {
                            if (err) {
                                reject(err);    // propagate write error to upstream
                            } else {
                                resolve();  // using a promise here to make backpressure work
                            }
                        });
                    }), (err?: Error) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    }).catch(err => {});    // drop err here because we already forwarded it above
                });
                res.sendStatus(200);
            } catch (err) {
                res.sendStatus(500);
                log.error(logCtx, "error streaming headless logs", err);
            }
        }));
        return router;
    }
}
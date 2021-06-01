/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { WorkspaceDB } from "@gitpod/gitpod-db/lib/workspace-db";
import { HeadlessLogSources } from "@gitpod/gitpod-protocol/lib/headless-workspace-log";
import { inject, injectable } from "inversify";
import * as url from "url";
import { Status, StatusServiceClient } from '@gitpod/supervisor-api-grpcweb/lib/status_pb_service'
import { TasksStatusRequest, TasksStatusResponse, TaskStatus } from "@gitpod/supervisor-api-grpcweb/lib/status_pb";
import { TerminalServiceClient } from "@gitpod/supervisor-api-grpcweb/lib/terminal_pb_service";
import { ListenTerminalRequest, ListenTerminalResponse } from "@gitpod/supervisor-api-grpcweb/lib/terminal_pb";
import { Stream } from "ts-stream";
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import { WorkspaceInstance } from "@gitpod/gitpod-protocol";
import { status as grpcStatus } from '@grpc/grpc-js';
import { Env } from "../env";
import * as browserHeaders from "browser-headers";
import { log } from '@gitpod/gitpod-protocol/lib/util/logging';
import { TextDecoder } from "util";

export interface WorkspaceLogStream {
    // stream of string chunks
    stream: Stream<string>;
}

@injectable()
export class WorkspaceLogService {
    static readonly SUPERVISOR_API_PATH = "/_supervisor/v1";

    @inject(WorkspaceDB) protected readonly db: WorkspaceDB;
    @inject(Env) protected readonly env: Env;

    public async getWorkspaceLogURLs(wsi: WorkspaceInstance): Promise<HeadlessLogSources | undefined> {
        // list workspace logs
        const streamIds = await this.listWorkspaceLogs(wsi);
        if (streamIds === undefined) {
            return undefined;
        }

        // render URLs 
        const streams: { [id: string]: string } = {};
        for (const [streamId, terminalId] of streamIds.entries()) {
            streams[streamId] = `/headless-logs/${wsi.workspaceId}/${terminalId}`;
        }
        return {
            streams
        };
    }

    /**
     * Returns a list of ids of streams for the given workspace
     * @param workspace 
     */
    async listWorkspaceLogs(wsi: WorkspaceInstance): Promise<Map<string, string> | undefined> {
        const tasks = await new Promise<TaskStatus[]>((resolve, reject) => {
            const client = new StatusServiceClient(toSupervisorURL(wsi.ideUrl), {
                transport: NodeHttpTransport(),
            });

            const req = new TasksStatusRequest();   // Note: Don't set observe here at all, else it won't work!
            const stream = client.tasksStatus(req, authHeaders(wsi));
            stream.on('data', (resp: TasksStatusResponse) => {
                resolve(resp.getTasksList());
                stream.cancel();
            });
            stream.on('end', (status?: Status) => {
                if (status && status.code !== grpcStatus.OK) {
                    const err = new Error(`upstream ended with status code: ${status.code}`);
                    (err as any).status = status;
                    reject(err);
                }
            });
        });

        const result = new Map<string, string>();
        tasks.forEach(t => result.set(t.getId(), t.getTerminal()));
        return result;
    }

    /**
     * For now, simply stream the supervisor data
     * 
     * @param workspace 
     * @param terminalID 
     */
    async getWorkspaceLog(wsi: WorkspaceInstance, terminalID: string): Promise<WorkspaceLogStream | undefined> {
        const client = new TerminalServiceClient(toSupervisorURL(wsi.ideUrl), {
            transport: NodeHttpTransport(),
        });
        const req = new ListenTerminalRequest();
        req.setAlias(terminalID);

        // [gpl] this is the very reason we cannot redirect the frontend to the supervisor URL: currently we only have ownerTokens for authentication
        const stream = new Stream<string>();
        const streamResp = client.listen(req, authHeaders(wsi));
        streamResp.on('data', (resp: ListenTerminalResponse) => {
            const raw = resp.getData();
            const data: string = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
            stream.write(data)
                .catch((err) => {
                    streamResp.cancel();    // If downstream reports an error: cancel connection to upstream
                    log.debug({ instanceId: wsi.id }, "stream cancelled", err);
                });   
        });
        streamResp.on('end', (status?: Status) => {
            let err: Error | undefined = undefined;
            if (status && status.code !== grpcStatus.OK) {
                err = new Error(`upstream ended with status code: ${status.code}`);
                (err as any).status = status;
            }
            stream.end(err);    // following this advice: https://www.npmjs.com/package/ts-stream#writing-to-a-stream-by-hand
        });
        return {
            stream,
        }
    }
}

function toSupervisorURL(ideUrl: string): string {
    const u = new url.URL(ideUrl);
    u.pathname = WorkspaceLogService.SUPERVISOR_API_PATH;
    return u.toString();
}

function authHeaders(wsi: WorkspaceInstance): browserHeaders.BrowserHeaders | undefined {
    const ownerToken = wsi.status.ownerToken;
    if (!ownerToken) {
        log.warn({ instanceId: wsi.id }, "workspace logs: owner token not found");
        return undefined;
    }
    const headers = new browserHeaders.BrowserHeaders();
    headers.set("x-gitpod-owner-token", ownerToken);
    return headers;
}

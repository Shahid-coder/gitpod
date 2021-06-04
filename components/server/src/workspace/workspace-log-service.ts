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
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import { WorkspaceInstance } from "@gitpod/gitpod-protocol";
import { status as grpcStatus } from '@grpc/grpc-js';
import { Env } from "../env";
import * as browserHeaders from "browser-headers";
import { log } from '@gitpod/gitpod-protocol/lib/util/logging';
import { TextDecoder } from "util";
import { WebsocketTransport } from "../util/grpc-web-ws-transport";

export interface Timeout {
    timeout: true,
}
export namespace Timeout {
    export function is(o: any): o is Timeout {
        return !!o && `timeout` in o;
    }
}

export type WorkspaceLogUrls =
        HeadlessLogSources
    |   Timeout
    |   undefined;

@injectable()
export class WorkspaceLogService {
    static readonly SUPERVISOR_API_PATH = "/_supervisor/v1";

    @inject(WorkspaceDB) protected readonly db: WorkspaceDB;
    @inject(Env) protected readonly env: Env;

    public async getWorkspaceLogURLs(wsi: WorkspaceInstance, maxTimeoutSecs: number = 30): Promise<WorkspaceLogUrls> {
        const streamIds = await this.retryWhileInstanceIsRunning(wsi, () => this.listWorkspaceLogs(wsi), maxTimeoutSecs);
        if (streamIds === undefined || Timeout.is(streamIds)) {
            return streamIds;
        }

        // render URLs 
        const streams: { [id: string]: string } = {};
        for (const [streamId, terminalId] of streamIds.entries()) {
            streams[streamId] = this.env.hostUrl.with({
                pathname: `/headless-logs/${wsi.id}/${terminalId}`,
            }).toString();
        }
        return {
            streams
        };
    }

    /**
     * Returns a list of ids of streams for the given workspace
     * @param workspace 
     */
    protected async listWorkspaceLogs(wsi: WorkspaceInstance): Promise<Map<string, string>> {
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
    async streamWorkspaceLog(wsi: WorkspaceInstance, terminalID: string, sink: (chunk: string) => Promise<void>, maxTimeoutSecs: number = 30): Promise<void | Timeout | undefined> {
        const client = new TerminalServiceClient(toSupervisorURL(wsi.ideUrl), {
            transport: WebsocketTransport(),    // necessary because HTTPTransport causes caching
        });
        const req = new ListenTerminalRequest();
        req.setAlias(terminalID);

        let receivedDataYet = false;
        const decoder = new TextDecoder('utf-8')
        const doStream = (cancelRetry: () => void) => new Promise<void>((resolve, reject) => {
            // [gpl] this is the very reason we cannot redirect the frontend to the supervisor URL: currently we only have ownerTokens for authentication
            const stream = client.listen(req, authHeaders(wsi));
            stream.on('data', (resp: ListenTerminalResponse) => {
                receivedDataYet = true;

                const raw = resp.getData();
                const data: string = typeof raw === 'string' ? raw : decoder.decode(raw);
                sink(data)
                    .catch((err) => {
                        stream.cancel();    // If downstream reports an error: cancel connection to upstream
                        log.debug({ instanceId: wsi.id }, "stream cancelled", err);
                    });   
            });
            stream.on('end', (status?: Status) => {
                if (!status || status.code === grpcStatus.OK) {
                    resolve();
                    return;
                }

                const err = new Error(`upstream ended with status code: ${status.code}`);
                (err as any).status = status;
                if (!receivedDataYet && (status.code === grpcStatus.UNKNOWN || status.code === grpcStatus.UNAVAILABLE)) {
                    log.debug("stream headless workspace log", err);
                    reject(err);
                    return;
                }
                
                cancelRetry();
                reject(err);
            });
        });
        return await this.retryWhileInstanceIsRunning(wsi, doStream, maxTimeoutSecs);
    }

    protected async retryWhileInstanceIsRunning<T>(wsi: WorkspaceInstance, op: (cancel: () => void) => Promise<T>, maxTimeoutSecs: number): Promise<T | Timeout | undefined> {
        let cancelled = false;
        const cancel = () => { cancelled = true; };

        let start = Date.now();
        let instance = wsi;
        while (!cancelled && Date.now() < start + (maxTimeoutSecs * 1000)) {
            // list workspace logs
            try {
                return await op(cancel);
            } catch (err) {
                if (cancelled) {
                    throw err;
                }

                log.debug("unable to fetch workspace log streams", err);
                const maybeInstance = await this.db.findInstanceById(instance.id);
                if (!maybeInstance) {
                    return undefined;
                }
                instance = maybeInstance;

                if (!this.shouldRetry(instance)) {
                    return undefined;
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
        }
        if (cancelled) {
            return undefined;
        }
        return { timeout: true };
    }

    protected shouldRetry(wsi: WorkspaceInstance): boolean {
        switch (wsi.status.phase) {
            case "creating":
            case "preparing":
            case "initializing":
            case "pending":
            case "running":
                return true;
            default:
                return false;
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

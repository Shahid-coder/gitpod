/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the Gitpod Enterprise Source Code License,
 * See License.enterprise.txt in the project root folder.
 */

import { User, WorkspaceContext, StartPrebuildContext, CommitContext } from "@gitpod/gitpod-protocol";
import { inject, injectable } from "inversify";
import { URL } from "url";
import { Env } from '../../../src/env';
import { HostContextProvider } from "../../../src/auth/host-context-provider";
import { IPrefixContextParser } from "../../../src/workspace/context-parser";

@injectable()
export class StartIncrementalPrebuildContextParser implements IPrefixContextParser {
    @inject(Env) protected env: Env;
    @inject(HostContextProvider) protected readonly hostContextProvider: HostContextProvider;
    static PREFIX = 'incremental-prebuild/';

    findPrefix(user: User, context: string): string | undefined {
        if (context.startsWith(StartIncrementalPrebuildContextParser.PREFIX)) {
            return StartIncrementalPrebuildContextParser.PREFIX;
        }
    }

    public async handle(user: User, prefix: string, context: WorkspaceContext): Promise<WorkspaceContext> {
        if (!CommitContext.is(context)) {
            throw new Error("can only start incremental prebuilds on a commit context")
        }

        const host = new URL(context.repository.cloneUrl).hostname;
        const hostContext = this.hostContextProvider.get(host);
        const maxDepth = this.env.incrementalPrebuildsCommitHistory;
        const result: StartPrebuildContext = {
            title: `Prebuild of "${context.title}"`,
            actual: context,
            commitHistory: await (hostContext?.contextParser?.fetchCommitHistory({}, user, context.repository.cloneUrl, context.revision, maxDepth) || [])
        };
        return result;
    }

}

/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the Gitpod Enterprise Source Code License,
 * See License.enterprise.txt in the project root folder.
 */

import { Team } from "@gitpod/gitpod-protocol";

export const TeamDB = Symbol('TeamDB');
export interface TeamDB {
    findTeamByName(name: string): Promise<Team | undefined>;
    findTeamsByUser(userId: string): Promise<Team[]>;
    createTeam(userId: string, name: string): Promise<Team>;
}
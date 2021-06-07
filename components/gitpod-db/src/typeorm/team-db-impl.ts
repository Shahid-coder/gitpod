/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { inject, injectable } from "inversify";
import { TypeORM } from "./typeorm";
import { Repository } from "typeorm";
import * as uuidv4 from 'uuid/v4';
import { TeamDB } from "../team-db";
import { DBTeam } from "./entity/db-team";
import { DBTeamMembership } from "./entity/db-team-membership";
import { Team } from "@gitpod/gitpod-protocol";

@injectable()
export class TeamDBImpl implements TeamDB {
    @inject(TypeORM) typeORM: TypeORM;

    protected async getEntityManager() {
        return (await this.typeORM.getConnection()).manager;
    }

    protected async getTeamRepo(): Promise<Repository<DBTeam>> {
        return (await this.getEntityManager()).getRepository<DBTeam>(DBTeam);
    }

    protected async getMembershipRepo(): Promise<Repository<DBTeamMembership>> {
        return (await this.getEntityManager()).getRepository<DBTeamMembership>(DBTeamMembership);
    }

    public async findTeamByName(name: string): Promise<Team | undefined> {
        const teamRepo = await this.getTeamRepo();
        return teamRepo.findOne({ name });
    }

    public async findTeamsByUser(userId: string): Promise<Team[]> {
        const teamRepo = await this.getTeamRepo();
        const membershipRepo = await this.getMembershipRepo();
        const memberships = await membershipRepo.find({ userId });
        return teamRepo.findByIds(memberships.map(m => m.teamId));
    }

    public async createTeam(userId: string, name: string): Promise<Team> {
        if (!name) {
            throw new Error('Team name cannot be empty');
        }
        const teamRepo = await this.getTeamRepo();
        const existingTeam = await teamRepo.findOne({ name });
        if (!!existingTeam) {
            throw new Error('A team with this name already exists');
        }
        const team: Team = {
            id: uuidv4(),
            name,
            creationTime: new Date().toISOString(),
        }
        await teamRepo.save(team);
        const membershipRepo = await this.getMembershipRepo();
        await membershipRepo.save({
            id: uuidv4(),
            teamId: team.id,
            userId,
            creationTime: team.creationTime,
        });
        return team;
    }
}

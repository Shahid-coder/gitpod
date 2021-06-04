/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { FormEvent, useState } from "react";
import { useHistory } from "react-router-dom";
import { getGitpodService } from "../service/service";

export default function () {
    const history = useHistory();
    const [ creationError, setCreationError ] = useState<Error>();
    let name = '';
    const createTeam = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await getGitpodService().server.createTeam(name);
            window.location.href = '/';
        } catch (error) {
            console.error(error);
            setCreationError(error);
        }
    }
    return <div className="flex flex-col w-96 mt-16 mx-auto items-center">
        <h1>New Team</h1>
        <p className="text-gray-500 text-center text-base">Teams allow you to <strong>group multiple projects</strong>, <strong>collaborate with others</strong>, <strong>manage subscriptions</strong> with one centralized billing, and more. <a href="">Learn more</a></p>
        <form className="mt-8 w-full" onSubmit={createTeam}>
            <div className="border rounded-xl p-6 border-gray-100">
                <h3 className="text-center text-xl mb-6">What's your team's name?</h3>
                <h4>Team Name</h4>
                <input className="w-full" type="text" onChange={event => name = event.target.value} />
                {!!creationError && <p className="text-gitpod-red">{creationError.message}</p>}
            </div>
            <div className="flex flex-row-reverse space-x-2 space-x-reverse mt-2">
                <button type="submit">Create Team</button>
                <button className="secondary" onClick={() => history.push('/')}>Cancel</button>
            </div>
        </form>
    </div>;
}
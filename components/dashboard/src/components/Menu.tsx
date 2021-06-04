/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { Team, User } from "@gitpod/gitpod-protocol";
import { useContext, useEffect, useState } from "react";
import { Link, useHistory } from "react-router-dom";
import { useLocation } from "react-router";
import { Location } from "history";
import gitpodIcon from '../icons/gitpod.svg';
import CaretDown from "../icons/CaretDown.svg";
import { getGitpodService, gitpodHostUrl } from "../service/service";
import { UserContext } from "../user-context";
import ContextMenu from "./ContextMenu";
import Separator from "./Separator";
import PillMenuItem from "./PillMenuItem";
import TabMenuItem from "./TabMenuItem";

interface Entry {
    title: string,
    link: string,
    alternatives?: string[]
}

function isSelected(entry: Entry, location: Location<any>) {
    const all = [entry.link, ...(entry.alternatives||[])];
    const path = location.pathname.toLowerCase();
    return all.some(n => n === path || n+'/' === path);
}

export default function Menu(props: { left: Entry[], right: Entry[], showTeams?: boolean }) {
    const { user } = useContext(UserContext);
    const history = useHistory();
    const location = useLocation();
    const [ teams, setTeams ] = useState<Team[]>([]);
    useEffect(() => {
        getGitpodService().server.getTeams().then(setTeams).catch(error => {
            console.error('Could not fetch teams!', error);
        });
    }, []);

    const userFullName = user?.fullName || user?.name || '...';

    return <>
        <header className="lg:px-28 px-10 flex flex-col pt-4 space-y-4">
            <div className="flex">
                <div className="flex justify-between items-center pr-3">
                    <Link to="/">
                        <img src={gitpodIcon} className="h-6" />
                    </Link>
                    <div className="ml-2 text-base">
                        {!!props.showTeams
                            ? <ContextMenu classes="w-64 left-0" menuEntries={[
                                {
                                    title: userFullName,
                                    customContent: <div className="w-full text-gray-400 flex flex-col">
                                        <span className="text-gray-800 text-base font-semibold">{userFullName}</span>
                                        <span className="">Personal Account</span>
                                    </div>,
                                    separator: true,
                                    onClick: () => {},
                                },
                                ...(teams || []).map(t => ({
                                    title: t.name,
                                    customContent: <div className="w-full text-gray-400 flex flex-col">
                                        <span className="text-gray-800 text-base font-semibold">{t.name}</span>
                                        <span className="">N members</span>
                                    </div>,
                                    separator: true,
                                    onClick: () => {},
                                })).sort((a,b) => a.title.toLowerCase() > b.title.toLowerCase() ? 1 : -1),
                                {
                                    title: 'Create a new team',
                                    customContent: <div className="w-full text-gray-400 flex items-center">
                                        <span className="flex-1 font-semibold">New Team</span>
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 14" className="w-3.5"><path fill="currentColor" fill-rule="evenodd" d="M7 0a1 1 0 011 1v5h5a1 1 0 110 2H8v5a1 1 0 11-2 0V8H1a1 1 0 010-2h5V1a1 1 0 011-1z" clip-rule="evenodd"/></svg>
                                    </div>,
                                    onClick: () => history.push("/new-team"),
                                }
                            ]}>
                                <div className="flex p-1.5 pl-3 rounded-lg hover:bg-gray-200">
                                    <span className="text-base text-gray-600 font-semibold">{userFullName}</span>
                                    <img className="m-2 filter-grayscale" src={CaretDown}/>
                                </div>
                            </ContextMenu>
                            : <nav className="flex-1">
                                <ul className="flex flex-1 items-center justify-between text-base text-gray-700 space-x-2">
                                    <li className="flex-1"></li>
                                    {props.left.map(entry => <li key={entry.title}>
                                        <PillMenuItem name={entry.title} selected={isSelected(entry, location)} link={entry.link}/>
                                    </li>)}
                                </ul>
                            </nav>
                        }
                    </div>
                </div>
                <div className="flex flex-1 items-center w-auto" id="menu">
                    <nav className="flex-1">
                        <ul className="flex flex-1 items-center justify-between text-base text-gray-700 space-x-2">
                            <li className="flex-1"></li>
                            {props.right.map(entry => <li key={entry.title}>
                                <PillMenuItem name={entry.title} selected={isSelected(entry, location)} link={entry.link}/>
                            </li>)}
                        </ul>
                    </nav>
                    <div className="ml-3 flex items-center justify-start mb-0 pointer-cursor m-l-auto rounded-full border-2 border-transparent hover:border-gray-200 dark:hover:border-gray-700 p-0.5 font-medium">
                        <ContextMenu menuEntries={[
                            {
                                title: (user && User.getPrimaryEmail(user)) || '',
                                customFontStyle: 'text-gray-400',
                                separator: true
                            },
                            {
                                title: 'Settings',
                                link: '/settings',
                                separator: true
                            },
                            {
                                title: 'Logout',
                                href: gitpodHostUrl.asApiLogout().toString()
                            },
                        ]}>
                            <img className="rounded-full w-6 h-6" src={user?.avatarUrl || ''} alt={user?.name || 'Anonymous'} />
                        </ContextMenu>
                    </div>
                </div>
            </div>
            {!!props.showTeams && <div className="flex">
                {props.left.map(entry => <TabMenuItem name={entry.title} selected={isSelected(entry, location)} link={entry.link}/>)}
            </div>}
        </header>
        {!!props.showTeams && <Separator />}
    </>;
}
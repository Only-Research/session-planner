# Installing Session Planner with an agent

For an AI agent whose user has asked it to install or set up Session Planner from this folder. The user may not be comfortable in a terminal, so explain each step in plain words, show them what you are about to run, and let them approve it.

## Steps

1. Run the installer from this folder and show the user its output:

   ```bash
   bash install.command
   ```

   It checks for Node.js and the planner's code packages, links `skills/session-plan` into `~/.claude/skills` and `~/.codex/skills` for whichever of Claude Code and Codex are installed, and starts the planner once on a throwaway store to prove it runs. It is safe to run again, and it downloads nothing.

2. If it reports a problem, handle it with the user:

   - **Node.js is missing or older than 20.** Tell the user to download the LTS installer from https://nodejs.org and run it, then run the installer again. Don't install Node.js yourself.
   - **The code packages are missing.** This happens when the folder came from `git clone` rather than the release zip. Explain that `npm ci --ignore-scripts`, run inside `server/`, downloads the exact package versions recorded in `server/package-lock.json` (72 packages) with install scripts switched off. Run it only after the user agrees, then run the installer again.
   - **An agent is already connected to another copy of Session Planner.** That copy may hold the user's sessions in its own `runs/` folder, and switching would leave them behind. Tell the user where the other copy is. If they want this copy instead, they can first stop that copy's planner and move the session folders from its `runs/` into this copy's `runs/`. Run `bash install.command --replace` only after they agree.
   - **A skills folder already has something named `session-plan` that isn't a link.** Tell the user what is there and ask what they want done with it. Don't move or delete it yourself.
   - **A link couldn't be created.** Your sandbox may not allow writing to `~/.claude` or `~/.codex`. Tell the user and ask them to double-click `install.command` themselves; the first-time macOS steps are in `START-HERE.txt`.
   - **The planner didn't start.** Show the user the message the installer printed and work out the cause with them before running it again.
   - **No agent found.** The installer looks for `~/.claude` and `~/.codex`. If the user runs a different agent, point it at `skills/session-plan/SKILL.md` in this folder instead.

3. When it reports that Session Planner is ready, tell the user:

   - Keep this folder where it is. The link points here, and sessions are saved in its `runs/` folder. To move it, stop the planner first, then run the installer again after the move. If the folder is in Downloads, the installer suggests moving the folder into the home folder and running the installer again.
   - Start a new conversation so the agent loads the new skill, then ask for a planning session in their own words, for example "Let's plan my kitchen renovation in Session Planner."

## What not to do

Don't change the installer's environment (such as `HOME`) or the links it makes, and don't install anything the steps above don't name. The README covers the same steps for people running the installer themselves.

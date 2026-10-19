# PC checks: Projects (owner, Windows; none can be done in a cloud session)

Mark each PASS / FAIL with a short note.

| # | Check |
|---|---|
| PJ-01 | Create a project (name, instructions) in the app. It appears in the rail select and on its page. |
| PJ-02 | Add two members. A native Windows dialog (not the app window) names the project and the agents; Cancel changes nothing, Confirm adds them. |
| PJ-03 | "Choose folder...": the Windows folder picker opens; pick a folder on another drive; the confirmation names the old and new path; Confirm sets it. A folder that is `%USERPROFILE%\.legion` (or inside) is refused with a sentence. |
| PJ-04 | Start a task in the project with a member agent. In the thread, ask the agent to repeat its project instructions and to create `hello.txt` in the project folder; the file is in the picked folder (junction/long paths if you try them). |
| PJ-05 | An agent that is not a member cannot be picked for a task while the project is chosen (rail lists only members). |
| PJ-06 | Library: save a note scoped to the project; a task in the project recalls it; a task in another project or in no project does not. |
| PJ-07 | Archive the project: its tasks stay listed, new tasks cannot start, continuing one shows the sentence; Unarchive restores. |
| PJ-08 | From Claude Code over MCP: `legion_projects` list/get work; there is no create/update tool; `POST /api/tasks` with a `projectId` and the token only answers 403. |
| PJ-09 | Restart Legion: projects, members, folders and task membership are still there. |
| PJ-10 | Keyboard only: reach the project select, open the page, edit instructions, add a member, with a screen reader (Narrator) announcing names and the status toast. |
| PJ-11 | Downgrade smoke (optional): start an older build on the same data dir: tasks open, project notes are not offered to bots, nothing crashes. |

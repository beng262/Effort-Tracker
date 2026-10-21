# Roadmap

Ideas for where this goes next. The rule stays the same for all of them: **AI reads, code decides**, and nothing is written (to the database or to Planner) before the person confirms.

- **Speech to text.** Dictate effort in Turkish into the assistant box; the browser's own recognition (Web Speech API, `tr-TR`) fills the box and the person still checks and sends it.
- **Project files.** A storage place on each project (Blob Storage) for documents, visible to the people on the project.
- **Planner write access.** Create and edit Planner tasks from the app (needs the Planner write permission and ETag handling in the Graph client).
- **Effort linked to Planner tasks.** Match effort rows to plan tasks and let the assistant ask "should I close this task for you?"; one click confirms.
- **Project reports by the assistant.** The assistant reads a project's effort rows, plan tasks and files and writes a report; numbers come from the database, wording from the model.

Done so far: edit project (name, customer, code), choose a project for a file attached in the assistant, and calendar meetings as effort (delegated, read-only, behind a feature flag).

# Project Data Integrity

## Repository Identity

GitHub repositories are stored as a canonical lowercase `owner/repo` value in `project.git_repo_url`.

Accepted inputs include:

- `owner/repo`
- `https://github.com/owner/repo`
- `https://github.com/owner/repo.git`
- `git@github.com:owner/repo.git`

The API normalizes this value in live project creation, owner project updates, project claiming, GitHub stats refresh, and legacy admin-only early submissions.

## Duplicate Policy

`project.git_repo_url` is unique at the database layer and checked defensively before owner edits.

- A new repository creates a `pending` project owned by the submitting user.
- A repository already owned by the same user is updated and returned to `pending` review.
- A repository owned by another user is rejected with a conflict.
- An unclaimed legacy repository can be claimed only after the user connects GitHub and passes ownership verification.
- A soft-deleted project owned by the same user can be restored by submitting the same repository again.

## Organization Repository Claims

Organization repositories use the same claim policy as personal repositories: the linked GitHub account token must prove access through the GitHub API. If GitHub does not report sufficient ownership or admin access for that account, the claim is rejected.

## Soft Deletes

Owner deletes set `deleted_at` instead of removing rows. Public project discovery and owner active project lists filter out rows with `deleted_at` set. Admin review/history can still inspect rows directly when needed.

# Introduction

First and foremost, we really want to thank you for considering contributing to vrognas-redmyne! We are hoping we can make this extension even better with your contribution!

This guide will help you get to know the rules that improves the communication between you and the maintainers, but also how to get started quickly.

We love to receive contributions from the community, like fixing the bugs, adding the documentation, proposing new features, and eventually implementing new features, and so on.

Please, make sure new features and support questions related to the extension are first put in the [Discussions](https://github.com/vrognas/vrognas-redmyne/discussions) tab on GitHub, where we can clarify questions and discuss new features before they are made.

# Ground Rules

- If you come up with a new feature, discuss it first in the [Discussions](https://github.com/vrognas/vrognas-redmyne/discussions) tab on GitHub with the maintainers and community
- Ensure your code is formatted with [Prettier](https://prettier.io) and checked with [eslint](https://eslint.org) (you may check both by simply running `npm run lint`)
- Keep PRs as small possible - do not batch multiple features within a single PR
- Try to keep PR with a single commit - otherwise maintainers may squash it into single commit
- Name your commits following the format described in Conventions section below
- Be welcoming to newcomers and encourage diverse new contributors from all backgrounds. See the [Code of Conduct](./docs/CODE_OF_CONDUCT.md).

# Your First Contribution

Unsure where to begin contributing to `vrognas-redmyne`? You can start by looking through issues labelled with 'good first issue' label.

> Working on your first Pull Request? You can learn more about how to do it on this site [https://www.firsttimersonly.com/](https://www.firsttimersonly.com/)

# Getting started

1. Create your own fork of the code
2. Do the changes in your fork
3. If you like the change and think the project could use it:

- Be sure you have followed the code style for the project.
- Add entry to the [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]` section, following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) convention.
- Send a pull request!

# How to report a bug

If you find a security vulnerability, do NOT open an issue. See [SECURITY.md](./.github/SECURITY.md) for reporting instructions.

When you want to create a bug report, make sure you fill out the issue template.

# How to suggest a feature or enhancement

`vrognas-redmyne` goal is to provide convenient commands and views, to boost developers work without leaving the IDE. This extension does not want to give the developer full redmine functionality, just a small portion of them, needed in day-to-day activities.

Before making a suggestion, make sure it was not requested before in the Issues and Discussion tabs on GitHub.

To make a suggestion, propose the feature or enhancement, please create a new discussion in the [Ideas](https://github.com/vrognas/vrognas-redmyne/discussions/categories/ideas) in Discussions on GitHub. Describe how a new functionality would help your workflow and provide as much context to it, so we can refine together the best possible solution to your flow.

Once refined, a discussion will be transformed into issue by the maintainers and the milestone will be set up.

# Code review process

Your pull request will be reviewed by the maintainers of the repository. We will mainly check the coding style, code architecture and test your contribution. Please do not feel like we are judging you - we just want to make sure our codebase is aligned. 😊

If you receive an approval and the pipeline checks are met, maintainers will merge your pull request into the repository. Congratulations - you're now a contributor of `vrognas-redmyne`! 🎉

Note: maintainers are working on `vrognas-redmyne` as a spare-time project, we will not always make reviews immediately. We will try to do it as soon as possible, but we do not promise any deadline to respond.

# Conventions

## Commit messages

Commit messages are validated locally by a `commit-msg` hook and in CI
(on PRs). The enforced rules:

- **Subject line**: max 50 characters
- **Blank line** between subject and body
- **Body lines**: max 72 characters each

The hook checks only those three. As a **project convention** (not
enforced), also use lowercase [Conventional Commits](https://www.conventionalcommits.org)
`type: description` — types: `feat`, `fix`, `refactor`, `docs`, `test`,
`chore`, `perf`, `ci`, `revert`.

**Examples:**
```
fix: resolve authentication timeout issue

feat: add GitHub templates for bug reports and PRs

chore: update dependencies to latest versions
```

**If validation fails:**
```bash
# Amend the commit message
git commit --amend

# Force push (safe variant)
git push --force-with-lease
```

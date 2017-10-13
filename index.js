/** Copyright (c) 2017 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {join, dirname, basename, sep} = require('path');

module.exports = robot => {
  robot.on('pull_request.opened', check);
  robot.on('pull_request.synchronize', check);
  robot.on('pull_request.edited', check);

  robot.on('issues.closed', reopenTodos);

  async function reopenTodos(context) {
    // re-open todos that may have been closed
    const issue = context.payload.issue;

    const results = await github.search.code({
      q: `TODO+repo:${context.payload.repository.full_name}`,
    });

    const files = await Promise.all(
      results.data.items.map(async item => {
        const res = await context.github.repos.getContent(
          context.repo({
            path: item.path,
          }),
        );
        return {
          filename: item.path,
          contents: Buffer.from(res.data.content, 'base64').toString(),
        };
      }),
    );

    for (file of files) {
      const todos = searchFile(file);
      for (todo of todos) {
        if (todo.issue === issue.number) {
          github.issues.edit(
            context.issue({
              state: 'open',
            }),
          );
          github.issues.createComment(
            context.issue({
              body:
                'This issue was automatically re-opened because it is referenced in a TODO.',
            }),
          );
        }
      }
    }
  }

  async function check(context) {
    const pr = context.payload.pull_request;

    function setStatus(status) {
      const params = Object.assign(
        {
          sha: pr.head.sha,
          context: 'TODOs',
        },
        status,
      );
      return github.repos.createStatus(context.repo(params));
    }

    const compare = await context.github.repos.compareCommits(
      context.repo({
        base: pr.base.sha,
        head: pr.head.sha,
      }),
    );

    const notRemoved = compare.data.files.filter(
      file => file.status !== 'removed',
    );

    const repoUrl = context.payload.repository.html_url;

    // Get link to line/blame of TODO
    // NOTE: for some reason GitHub breaks these URLs...
    function getUrl(todo) {
      return join(
        repoUrl,
        'blame',
        pr.head.sha,
        `${todo.filename}#L${todo.line}`,
      );
    }

    const files = await Promise.all(
      notRemoved.map(async file => {
        const res = await context.github.repos.getContent(
          context.repo({
            path: file.filename,
            ref: pr.head.sha,
          }),
        );
        return {
          filename: file.filename,
          contents: Buffer.from(res.data.content, 'base64').toString(),
        };
      }),
    );

    const todos = files.reduce((acc, file) => {
      return acc.concat(searchFile(file));
    }, []);

    const missingIssues = [];
    const withIssues = [];

    todos.forEach(todo => {
      if (todo.issue === void 0) {
        missingIssues.push(todo);
      } else {
        withIssues.push(todo);
      }
    });

    // Early return if issue numbers are missing
    if (missingIssues.length) {
      return setStatus({
        state: 'failure',
        description: 'TODO without open GitHub issue',
        target_url: getUrl(missingIssues[0]),
      });
    }

    const issues = withIssues.map(async todo => {
      try {
        const issue = await context.github.issues.get(
          context.issue({
            number: todo.issue,
          }),
        );
        return {...todo, issueState: issue.data.state};
      } catch (err) {
        if (err.code !== 404) {
          throw err;
        }
        return {...todo, issueState: void 0};
      }
    });

    for (todo of await Promise.all(issues)) {
      if (todo.issueState !== 'open') {
        return setStatus({
          state: 'failure',
          description: 'No open issue for TODO',
          target_url: getUrl(todo),
        });
      }
    }

    return setStatus({
      state: 'success',
      description: 'All TODOs have open issues',
    });
  }
};

const parseTodo = /TODO(?:\(#(\d+)\))?/g;

function searchFile(file) {
  const lines = file.contents.split('\n');
  const todos = [];
  lines.forEach((line, index) => {
    let todo;
    while ((todo = parseTodo.exec(line)) !== null) {
      todos.push({
        filename: file.filename,
        line: index + 1,
        issue: todo[1] ? parseInt(todo[1]) : void 0,
      });
    }
  });
  return todos;
}

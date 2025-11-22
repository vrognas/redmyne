import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import listOpenIssues from '../../../src/commands/list-open-issues-assigned-to-me';

describe('listOpenIssuesAssignedToMe', () => {
  it('should fetch and display issues', async () => {
    const mockServer = {
      getIssuesAssignedToMe: vi.fn().mockResolvedValue({ issues: [] }),
      options: { url: { hostname: 'test.redmine.com' } },
    };

    const props = { server: mockServer, config: {} };

    await listOpenIssues(props);

    expect(mockServer.getIssuesAssignedToMe).toHaveBeenCalled();
  });
});

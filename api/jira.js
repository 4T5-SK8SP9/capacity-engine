// api/jira.js — Vercel serverless function
// Proxies Jira API calls so the API token stays server-side

export default async function handler(req, res) {
  // Allow requests from GitHub Pages and Vercel deployments
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { projectKey } = req.query;
  if (!projectKey) {
    return res.status(400).json({ error: 'Missing projectKey parameter' });
  }

  const JIRA_BASE_URL  = process.env.JIRA_BASE_URL;
  const JIRA_EMAIL     = process.env.JIRA_EMAIL;
  const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).json({ error: 'Jira credentials not configured on server' });
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  try {
    // ── 1. Get active sprint ────────────────────────────────────────────────
    const boardRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum`,
      { headers }
    );
    if (!boardRes.ok) {
      const err = await boardRes.text();
      return res.status(boardRes.status).json({ error: `Board lookup failed: ${err}` });
    }
    const boardData = await boardRes.json();
    if (!boardData.values || boardData.values.length === 0) {
      return res.status(404).json({ error: `No scrum board found for project ${projectKey}` });
    }
    const boardId = boardData.values[0].id;
    const boardName = boardData.values[0].name;

    // ── 2. Get active sprint from board ─────────────────────────────────────
    const sprintRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint?state=active`,
      { headers }
    );
    if (!sprintRes.ok) {
      return res.status(sprintRes.status).json({ error: 'Failed to fetch active sprint' });
    }
    const sprintData = await sprintRes.json();
    if (!sprintData.values || sprintData.values.length === 0) {
      return res.status(404).json({ error: `No active sprint found for project ${projectKey}` });
    }
    const sprint = sprintData.values[0];
    const sprintId = sprint.id;
    const sprintName = sprint.name;
    const startDate = sprint.startDate ? sprint.startDate.substring(0, 10) : '';
    const endDate   = sprint.endDate   ? sprint.endDate.substring(0, 10)   : '';

    // Calculate sprint length in days
    let sprintLengthDays = 10; // default 2 weeks
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end   = new Date(endDate);
      const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
      // Convert calendar days to working days (rough estimate)
      sprintLengthDays = Math.round(diffDays * 5 / 7);
    }

    // ── 3. Get issues in active sprint ──────────────────────────────────────
    const issuesRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint/${sprintId}/issue?maxResults=100&fields=assignee,status,story_points,customfield_10022,customfield_10016,customfield_10028`,
      { headers }
    );
    if (!issuesRes.ok) {
      return res.status(issuesRes.status).json({ error: 'Failed to fetch sprint issues' });
    }
    const issuesData = await issuesRes.json();
    const issues = issuesData.issues || [];

    // ── 4. Extract team members from assignees ──────────────────────────────
    const memberMap = {};
    issues.forEach(issue => {
      const assignee = issue.fields?.assignee;
      if (assignee && assignee.accountId) {
        if (!memberMap[assignee.accountId]) {
          memberMap[assignee.accountId] = {
            name: assignee.displayName,
            role: 'Dev',
            availabilityPct: 100,
            jiraId: assignee.accountId,
          };
        }
      }
    });
    const teamMembers = Object.values(memberMap);

    // ── 5. Calculate carry-over (issues not done from previous sprint) ──────
    const completedStatuses = ['done', 'closed', 'resolved', 'complete'];
    const incompleteIssues = issues.filter(issue => {
      const status = issue.fields?.status?.name?.toLowerCase() || '';
      return !completedStatuses.some(s => status.includes(s));
    });

    // Get story points from the field that exists (Pandora uses customfield_10022)
    const getPoints = (fields) =>
      fields?.customfield_10022 ||
      fields?.customfield_10016 ||
      fields?.customfield_10028 ||
      fields?.story_points || 0;

    const carryOverPoints = incompleteIssues.reduce((sum, issue) => {
      return sum + (getPoints(issue.fields) || 0);
    }, 0);

    // ── 6. Get last 3 completed sprints for velocity ─────────────────────────
    const closedSprintRes = await fetch(
      `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint?state=closed&maxResults=3`,
      { headers }
    );
    let velocityLast3 = [];
    if (closedSprintRes.ok) {
      const closedData = await closedSprintRes.json();
      const closedSprints = (closedData.values || []).slice(-3);

      for (const cs of closedSprints) {
        try {
          const csIssuesRes = await fetch(
            `${JIRA_BASE_URL}/rest/agile/1.0/board/${boardId}/sprint/${cs.id}/issue?maxResults=100&fields=status,customfield_10022,customfield_10016,customfield_10028`,
            { headers }
          );
          if (csIssuesRes.ok) {
            const csData = await csIssuesRes.json();
            const completedPoints = (csData.issues || []).reduce((sum, issue) => {
              const status = issue.fields?.status?.name?.toLowerCase() || '';
              const isDone = completedStatuses.some(s => status.includes(s));
              return isDone ? sum + (getPoints(issue.fields) || 0) : sum;
            }, 0);
            if (completedPoints > 0) velocityLast3.push(Math.round(completedPoints));
          }
        } catch (e) {
          // skip failed sprint
        }
      }
    }

    // ── 7. Return formatted data ─────────────────────────────────────────────
    return res.status(200).json({
      teamName: boardName || projectKey,
      sprintName,
      sprintLengthDays,
      startDate,
      endDate,
      teamMembers,
      velocityLast3,
      carryOverPoints: Math.round(carryOverPoints),
      projectKey,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Jira proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
}

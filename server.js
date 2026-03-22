require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== メッセージ解析 =====
function parseMessage(text) {
  const parts = text.split("|");

  if (parts.length < 6) {
    throw new Error("形式：プロジェクト|種別|件名|期限|担当|詳細");
  }

  return {
    projectKey: parts[0],
    issueType: parts[1],
    summary: parts[2],
    dueDate: parts[3],
    assigneeName: parts[4],
    description: parts[5],
  };
}

// ===== Jiraユーザー検索（名前→accountId）=====
async function getAccountIdByName(name) {
  if (!name) return null;

  const res = await axios.get(
    `${process.env.JIRA_BASE_URL}/rest/api/3/user/search?query=${encodeURIComponent(
      name
    )}`,
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
          ).toString("base64"),
        Accept: "application/json",
      },
    }
  );

  if (res.data.length > 0) {
    return res.data[0].accountId;
  }

  return null;
}

// ===== Jiraチケット作成 =====
async function createJiraIssue(task) {
  const accountId = await getAccountIdByName(task.assigneeName);

  const data = {
    fields: {
      project: {
        key: task.projectKey,
      },
      summary: task.summary,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: task.description,
              },
            ],
          },
        ],
      },
      issuetype: {
        name: task.issueType,
      },
      duedate: task.dueDate,
    },
  };

  // 担当者がいる場合のみセット
  if (accountId) {
    data.fields.assignee = {
      accountId: accountId,
    };
  }

  const res = await axios.post(
    `${process.env.JIRA_BASE_URL}/rest/api/3/issue`,
    data,
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
          ).toString("base64"),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }
  );

  return res.data.key;
}

// ===== LINE Webhook =====
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;

    for (const e of events) {
      if (e.type === "message" && e.message.type === "text") {
        const text = e.message.text;

        console.log("RAW TEXT:", text);

        const task = parseMessage(text);

        const issueKey = await createJiraIssue(task);

        await axios.post(
          "https://api.line.me/v2/bot/message/reply",
          {
            replyToken: e.replyToken,
            messages: [
              {
                type: "text",
                text: `作成成功: ${issueKey}`,
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error(err.message);

    // エラー時もLINEに返す
    if (err.response) {
      console.error(err.response.data);
    }

    res.status(200).send("ERROR");
  }
});

// ===== 起動 =====
app.listen(PORT, () => {
  console.log("Server running:", PORT);
});

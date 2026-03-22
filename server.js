require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ■ LINE設定
const LINE_API_URL = "https://api.line.me/v2/bot/message/push";
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

// ■ Webhook（Jiraから受け取る）
app.post("/webhook", async (req, res) => {
  try {
    console.log("=== JIRA WEBHOOK ===");
    console.log(JSON.stringify(req.body, null, 2));

    const issue = req.body;

    const message = `
【期限超過タスク⚠️】
キー: ${issue.issueKey}
タイトル: ${issue.summary}
担当者: ${issue.assignee}
優先度: ${issue.priority}
ステータス: ${issue.status}
`;

    await axios.post(
      LINE_API_URL,
      {
        to: LINE_USER_ID,
        messages: [
          {
            type: "text",
            text: message,
          },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );

    res.status(200).send("OK");
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.status(500).send("ERROR");
  }
});

// ■ 起動
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

#!/bin/bash
# Create bottalk repo in Gitea
TOKEN="d7a5cc54a4546d42ef5e4d9d73e202d0d3dcf459"
curl -s -X POST http://gitea.gitea.svc.cluster.local:3000/api/v1/user/repos \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"bottalk","description":"BotTalk Message Push Platform","private":false,"auto_init":false}'

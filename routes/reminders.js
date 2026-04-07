const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

// 所有操作需要登录
router.use(requireLogin);

// 获取提醒列表
router.get('/', (req, res) => {
  const userId = req.session.userId;
  const reminders = db.prepare(`
    SELECT * FROM reminders WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId);
  res.json({ success: true, data: reminders });
});

// 添加提醒
router.post('/', (req, res) => {
  const userId = req.session.userId;
  const { title, message, time, type, max_count } = req.body;

  const result = db.prepare(`
    INSERT INTO reminders (user_id, title, message, time, type, max_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, title, message || '', time, type || 'once', max_count || 0);

  res.json({ success: true, id: result.lastInsertRowid });
});

// 删除提醒（验证所有权）
router.delete('/:id', (req, res) => {
  const userId = req.session.userId;
  const reminder = db.prepare('SELECT id FROM reminders WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!reminder) return res.json({ success: false, error: '提醒不存在' });
  // 先删关联的 logs 记录（外键约束）
  db.prepare('DELETE FROM logs WHERE reminder_id = ?').run(reminder.id);
  db.prepare('DELETE FROM reminders WHERE id = ?').run(reminder.id);
  res.json({ success: true });
});

// 启用/禁用（验证所有权）
router.patch('/:id/enable', (req, res) => {
  const userId = req.session.userId;
  const { enabled } = req.body;
  db.prepare('UPDATE reminders SET enabled = ? WHERE id = ? AND user_id = ?')
    .run(enabled ? 1 : 0, req.params.id, userId);
  res.json({ success: true });
});

module.exports = router;

// Liveness handler has no database, session, scheduler, or external HTTP dependency.
function healthz(_req, res) {
  res.status(200).type('text/plain').send('ok');
}

module.exports = { healthz };

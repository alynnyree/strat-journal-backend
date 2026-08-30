// Express 4 does not understand a route handler that fails.
//
// If an `async (req, res) => {...}` handler throws, Express 4 never sees
// it: the failure becomes a promise nobody is holding, which ends the
// entire Node process. That is not a theory — it is checked directly in
// this project's route tests, and it is the most likely explanation for
// the "Exited with status 1" alert the owner received, because the route
// his phone polls every thirty seconds (/api/trades/pending) was one of
// ten with nothing around it. One hiccup reaching storage while his phone
// was open would have taken the whole server down.
//
// wrap() hands any failure to Express's own error handling instead, so a
// failing request answers with an error and the server keeps running.
// Use it on EVERY async route handler.
function wrap(fn) {
  return function (req, res, next) {
    try {
      return Promise.resolve(fn.call(this, req, res, next)).catch(next);
    } catch (err) {
      // A handler that throws before its first await never returns a
      // promise at all, so .catch above would never see it.
      return next(err);
    }
  };
}

// The last thing mounted: turns anything that got this far into a plain
// answer instead of a hung request. Never shows the owner the raw text --
// that rule exists because a lapsed Schwab sign-in once reached his
// screen as a wall of server error codes.
function errorHandler(err, req, res, next) {
  console.log(`Request failed (${req.method} ${req.originalUrl}):`, (err && err.stack) || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server. Nothing you saved is affected.' });
}

module.exports = { wrap, errorHandler };

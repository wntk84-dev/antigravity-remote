const cdp = require('./cdp');

/** Capture a PNG screenshot of the current Antigravity screen */
async function captureScreenshot() {
  await cdp.connect();
  return cdp.screenshot();
}

module.exports = { captureScreenshot };

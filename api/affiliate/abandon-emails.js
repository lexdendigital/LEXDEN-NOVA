'use strict';
// Backward-compatible route module: the old path delegates to the shared
// locked lifecycle job rather than maintaining a separate processor.
module.exports = require('../process-abandon-emails');

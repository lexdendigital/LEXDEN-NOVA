const admin = require('firebase-admin');
const { registerRoutes } = require('./oauth');  // ← CHANGED: registerRoutes, not setupOAuth

function mountMcp(app) {
  try {
    registerRoutes(app);  // ← CHANGED: call registerRoutes()
    console.log('MCP OAuth server mounted');
  } catch (err) {
    console.error('Failed to mount MCP:', err.message);
    recordServerError({ 
      type: 'mcpSetupError', 
      message: err.message, 
      stack: err.stack 
    });
  }
}

function recordServerError(errorObj) {
  const { type, message, stack, path } = errorObj;
  
  const logEntry = {
    type,
    message,
    stack,
    path: path || null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  };

  admin
    .firestore()
    .collection('serverErrors')
    .add(logEntry)
    .catch(err => {
      console.error('recordServerError failed (non-fatal):', err.message);
    });
}

module.exports = {
  mountMcp,
  recordServerError,
};

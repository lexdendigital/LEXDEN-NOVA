// /mcp/index.js
// MCP (Model Context Protocol) server entry point
// Exports functions called by server.js during initialization

const admin = require('firebase-admin');
const { setupOAuth } = require('./oauth');

/**
 * Mount MCP routes and initialize OAuth server for Claude connector
 * Called during server startup to register all MCP endpoints
 */
function mountMcp(app) {
  try {
    setupOAuth(app);
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

/**
 * Record server errors to Firestore for monitoring (nova_get_recent_server_errors)
 * Non-fatal — errors in this function don't crash the server
 */
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
      // Silent fail — don't crash if Firestore write fails
      console.error('recordServerError failed (non-fatal):', err.message);
    });
}

module.exports = {
  mountMcp,
  recordServerError,
};

module.exports = {
  apps: [{
    name: "ai-video-bot",
    script: "./backend/server.js",
    watch: true,
    env: { NODE_ENV: "production" }
  }]
}

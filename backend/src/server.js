const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const routes = require('./routes');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const mongoose = require('mongoose');
const config = require('./config');

const { registerDomain } = require('./domains/registry');
const { domains } = require('./domains/index');

if (config.domains) {
    config.domains.forEach(d => {
        if (domains[d.name]) {
            registerDomain(domains[d.name]);
            console.log(`[Domain Registry] Registered: ${d.name}`);
        } else {
            console.warn(`[Domain Registry] Warning: Configured domain '${d.name}' has no available module implementation.`);
        }
    });
}

// Connect to MongoDB for logging
const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || config.mongodb?.uri || 'mongodb://localhost:27017/synx_logs';
mongoose.connect(mongoUri)
    .then(() => console.log('Connected to MongoDB Logging Database'))
    .catch(err => console.error('MongoDB connection error:', err.message));

// Middleware
const cookieParser = require('cookie-parser');
app.use(cors({ credentials: true, origin: process.env.CORS_ORIGIN || config.settings?.server?.corsOrigin || 'http://localhost:5173' }));
app.use(bodyParser.json());
app.use(cookieParser());

// Routes
app.use('/api', routes);

// Serve Static Frontend
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// Start Server
if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`Synx Node Server running on port ${PORT}`);
        
        // Initialize TaskManager for scheduled background jobs
        const TaskManager = require('./TaskManager');
        TaskManager.init(config);
    });

    // Graceful Shutdown Handler (für Nodemon und reguläres Beenden)
    const gracefulShutdown = (signal) => {
        console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
        server.close();
        if (mongoose.connection.readyState === 1) {
            mongoose.connection.close(false);
        }
        
        // Nodemon restart or normal exit - force exit to free port instantly
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Ctrl+C
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker stop
}

module.exports = app;

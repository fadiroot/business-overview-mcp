const express = require('express');
const reports = require('./reports/legacy-router');
const app = express();
app.use('/api/reports', reports);
app.get('/health', (req, res) => res.send('ok'));

const express = require('express');
const cors = require('cors');
const http = require('http');
const apiRoutes = require('./routes/api');


require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT;  // 5000

// Use the routes
app.use('/api', apiRoutes);
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});


server.listen(PORT ,'0.0.0.0', () => {
    console.log(`the server is running on ${PORT}`);
});
server.on('error', (error) => {
    console.error('server error: ', error);
    process.exit(1);
});
process.on('SIGINT', () => {
    server.close(() => {
        console.log('server is closing bye!');
        process.exit(0);
    })
})

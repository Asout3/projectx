const express = require('express');
const cors = require('cors');
const http = require('http');
const apiRoutes = require('./routes/api');

// hello this is mikiyas 
require('dotenv').config();

const app = express();
const server = http.createServer(app);

//app.options('*', cors());  // allow preflight


app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition']
}));

//app.options('*', cors()); // <--- allow preflight requests


app.use(express.json());

const PORT = process.env.PORT;  // 5000

// Use the routes
app.use('/api', apiRoutes);

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });


//'0.0.0.0',

server.listen(PORT , '0.0.0.0',() => {
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

// this seems like it would work


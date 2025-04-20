const express = require('express');
const cors = require('cors');
const http = require('http');
const apiRoutes = require('./routes/api');


require('dotenv').config();

const app = express();
const server = http.createServer(app);

//app.options('*', cors());  // allow preflight


app.use(cors({
    origin: ['https://animated-parakeet-v6qgvrg4r59x2w4j5-3000.app.github.dev/'],
    methods: ['POST','OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    //allowedHeaders: ['Content-Type'],
    exposedHeaders: ['Content-Disposition']
    //credentials: true
  }));

app.use(express.json());

const PORT = process.env.PORT;  // 5000

// Use the routes
app.use('/api', apiRoutes);
// app.use((req, res, next) => {
//     if (req.method === 'OPTIONS') {
//       return res.sendStatus(200);
//     }
//     next();
//   });
// 

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
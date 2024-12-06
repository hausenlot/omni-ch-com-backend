const express = require('express');
const twilio = require('twilio');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const socketIo = require('socket.io');
const multer = require("multer");
const path = require("path");

// Twilio credentials (from your Twilio dashboard)
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twimlAppSid = process.env.TWIML_APP_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
const apiKeySid = process.env.TWILIO_API_KEY_SID;

let callAccepted = false; // In-memory tracking (replace with Redis or DB in production)

const client = twilio(accountSid, authToken);

const port = 5000;
const app = express();
const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/"); // Files will be saved in the "uploads" folder
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname); // Use a timestamp to make filenames unique
  },
});

const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://3cf6-112-207-98-153.ngrok-free.app"],  // Allow your frontend to connect
    methods: ["GET", "POST"]
  }
});

const chatNamespace = io.of("/chat");

chatNamespace.on("connection", (socket) => {
  const userEmail = socket.handshake.query.userEmail;
  console.log(`User connected: ${userEmail}`);

  socket.on('sendMessage', (data) => {
    console.log(`Message from ${data.sender}: ${data.text}`);
    chatNamespace.emit('receiveMessage', data);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${userEmail}`);
  });
});

const upload = multer({ storage: storage });

app.use(express.urlencoded({ extended: false }));

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

// Store received messages
let receivedMessages = [];

// Middleware
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// API endpoint to send SMS
app.post('/send-sms', (req, res) => {
  const { from, to, message } = req.body;

  console.log('Sending SMS:', { from, to, message }); // Log the details

  client.messages
    .create({
      body: message,
      from: from,
      to: to,
    })
    .then((message) => {
      console.log('Twilio Response:', message); // Log Twilio's full response
      res.status(200).json({ success: true, sid: message.sid });
    })
    .catch((error) => {
      console.error('Detailed Twilio Error:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message,
        details: error
      });
    });
});

// Fix by claude. Receive Message 
app.get('/fetch-received-messages', async (req, res) => {
  const phoneNumber = req.query.phoneNumber; // Get the phone number from the query

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  try {
    // Basic authentication for Twilio API
    const auth = {
      username: accountSid,
      password: authToken,
    };

    // Fetch messages from Twilio, filtered to only show received messages
    const response = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        auth,
        params: {
          PageSize: 50, // Number of messages to retrieve
          To: phoneNumber, // Dynamic phone number
        },
      }
    );

    // Filter and transform received messages
    const receivedMessages = response.data.messages
      .filter((message) => message.direction === 'inbound')
      .map((message) => ({
        sid: message.sid,
        from: message.from,
        body: message.body,
        dateSent: message.date_sent,
        status: message.status,
      }));

    res.json(receivedMessages);
  } catch (error) {
    console.error('Error fetching received messages:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Failed to fetch received messages',
      details: error.response ? error.response.data : error.message,
    });
  }
});

// API endpoint to get the received messages
app.get('/get-messages', (req, res) => {
  res.status(200).json(receivedMessages); // Return the list of received messages
});

app.get('/token', (req, res) => {
  const identity = 'user123'; // The identity for the user

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid, // The SID of your Twilio app
    incomingAllow: true, // Allow incoming calls
  });

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity: identity,
  });
  token.addGrant(voiceGrant);

  res.json({ token: token.toJwt() });
});

app.post('/incoming-call', (req, res) => {
  console.log("INCOMING CALL");

  const twiml = new twilio.twiml.VoiceResponse();

  // Play a message while waiting for the call to be accepted
  twiml.say("Please wait while we connect your call.");
  twiml.redirect('/wait-for-acceptance');

  // Notify the frontend
  io.emit('incomingCall', { message: 'Incoming call! Please pick up.' });

  res.type('text/xml');
  res.send(twiml.toString());
});

// New route to handle waiting state
app.post('/wait-for-acceptance', (req, res) => {
  console.log("WAITING FOR ACCEPTANCE");

  const twiml = new twilio.twiml.VoiceResponse();

  if (callAccepted) {
    console.log("CALL ACCEPTED!");

    // Proceed with the call
    twiml.say('Hello! You have reached the test Twilio app.');
  } else {
    // Keep waiting with a holding message
    twiml.say('Still waiting for the call to be accepted. Please hold.');
    twiml.pause({ length: 10 }); // Short pause to avoid infinite looping
    twiml.redirect('/wait-for-acceptance'); // Redirect back to itself
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Modify accept-call route to set acceptance status
app.post('/accept-call', (req, res) => {
  const { status } = req.body;

  if (status === 'accepted') {
    console.log("CALL ACCEPTED!");
    callAccepted = true; // Update call acceptance status
    res.json({ success: true });
  } else {
    res.status(400).send('Call not accepted');
  }
});

app.post('/make-call', async (req, res) => {
  const { to, from } = req.body; // Get the phone number from the request body

  // Your Twilio SID, Auth Token, and Twilio phone number
  const twilioClient = require('twilio')(accountSid, authToken);

  try {
    const call = await twilioClient.calls.create({
      to,
      from,
      url: 'https://16c3-112-207-98-153.ngrok-free.app/twiml', // URL for TwiML instructions
    });

    res.status(200).json({ message: 'Call initiated', callSid: call.sid });
  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ message: 'Failed to make the call' });
  }
});

app.post('/twiml', (req, res) => {
  console.log('TwiML endpoint hit!');
  console.log('Request body:', req.body);

  const { to } = req.body;

  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Hello, you are now connected!');
  twiml.pause({ length: 1 }); // Optional: add a brief pause
  twiml.dial(to);

  res.type('text/xml');
  res.send(twiml.toString());
});

// File upload route
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    const fileMessage = {
      type: 'file',
      url: req.file 
        ? `/uploads/${req.file.filename}` 
        : null,
      filename: req.file 
        ? req.file.originalname 
        : null,
      sender: req.body.userEmail,
      userId: req.body.userId,
      text: req.body.message || '' // Optional text message with file
    };

    // Emit file message to all clients
    chatNamespace.emit('chat message', fileMessage);

    res.json({ 
      message: "Upload successful", 
      filePath: fileMessage.url 
    });
  } catch (error) {
    console.error("File upload error:", error);
    res.status(500).json({ error: "File upload failed" });
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
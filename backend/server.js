const express = require('express');
const cors = require('cors');
require('dotenv').config();

const junctionRoutes = require('./Routes/junctionRoutes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({ message: 'Traffic backend is running' });
});

app.use('/api/junctions', junctionRoutes);

const PORT = process.env.PORT || process.env.VITE_PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

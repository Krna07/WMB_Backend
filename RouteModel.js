const mongoose = require('mongoose')



const stopSchema = new mongoose.Schema({
  stopName: {
    type: String,
    required: true,
  },
  latitude: {
    type: Number,
    required: true,
  },
  longitude: {
    type: Number,
    required: true,
  },
  stopOrder: {
    type: Number,
    required: true,
  },
});

const routeSchema = new mongoose.Schema({
  routeName: {
    type: String,
    required: true,
  },
  agencyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agency',
    required: false,
  },
  numberOfStops: {
    type: Number,
    required: true,
  },
  stops: [stopSchema], // embedded array of stops
  distanceKm: {
    type: Number,
    required: true,
  },
}, { timestamps: true });

module.exports = mongoose.model("Route", routeSchema);

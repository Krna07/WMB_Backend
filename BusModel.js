  const mongoose = require('mongoose');

  // Reuse existing mongoose connection from other models (UserModel connects)

  const busSchema = new mongoose.Schema({
    shortId: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      minlength: 4,
      maxlength: 4,
      match: /^[A-Z0-9]{4}$/,
    },
    registration: {
      type: String,
      required: false,
      trim: true,
    },
    busNumber: {
      type: String,
      required: false,
      trim: true,
    },
    agencyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Agency',
      required: false,
    },
    routeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Route',
      required: true,
    },
    routeName: {
      type: String,
      required: false,
      trim: true,
    },
  }, { timestamps: true });

  module.exports = mongoose.model('Bus', busSchema);



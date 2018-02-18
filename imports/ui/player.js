import { Template } from 'meteor/templating';
import { Players } from '../api/players.js';
import './player.html';

Template.player.helpers({
    selected: function () {
        return Session.equals("selectedPlayer", this._id) ? "selected" : '';
    }
});

Template.player.events({
    'click': function () {
        Session.set("selectedPlayer", this._id);
    }
});
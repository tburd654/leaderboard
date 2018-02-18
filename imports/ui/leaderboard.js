import { Template } from 'meteor/templating';
import { Players } from "../api/players";

import './leaderboard.html';

Template.leaderboard.helpers({
    players: function () {
        return Players.find({}, { sort: { score: -1, name: 1 } });
    },
    selectedName: function () {
        var player = Players.findOne(Session.get("selectedPlayer"));
        return player && player.name;
    }
});

Template.leaderboard.events({
    'click .inc': function () {
        Players.update(Session.get("selectedPlayer"), {$inc: {score: 5}});
    }
});
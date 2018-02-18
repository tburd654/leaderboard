import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';
import { Players } from '../imports/api/players.js';

Meteor.startup(function () {
    if (Players.find().count() === 0) {
        var names = ["Ada Lovelace", "Grace Hopper", "Marie Curie",
            "Carl Friedrich Gauss", "Nikola Tesla", "Claude Shannon"];
        _.each(names, function (name) {
            Players.insert({
                name: name,
                score: Math.floor(Random.fraction() * 10) * 5
            });
        });
    }
});
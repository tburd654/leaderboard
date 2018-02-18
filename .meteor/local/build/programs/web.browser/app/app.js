var require = meteorInstall({"imports":{"ui":{"body.html":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/body.html                                                                          //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
module.watch(require("./template.body.js"), {
  "*": module.makeNsSetter(true)
});

///////////////////////////////////////////////////////////////////////////////////////////////////

},"template.body.js":function(){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/template.body.js                                                                   //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //

Template.body.addContent((function() {
  var view = this;
  return HTML.DIV({
    class: "outer"
  }, HTML.Raw('\n    <div class="logo"></div>\n    <h1 class="title">Leaderboard</h1>\n    <div class="subtitle">Select a scientist to give them points</div>\n    '), Spacebars.include(view.lookupTemplate("leaderboard")), "\n");
}));
Meteor.startup(Template.body.renderToDocument);

///////////////////////////////////////////////////////////////////////////////////////////////////

},"leaderboard.html":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/leaderboard.html                                                                   //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
module.watch(require("./template.leaderboard.js"), {
  "*": module.makeNsSetter(true)
});

///////////////////////////////////////////////////////////////////////////////////////////////////

},"template.leaderboard.js":function(){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/template.leaderboard.js                                                            //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //

Template.__checkName("leaderboard");
Template["leaderboard"] = new Template("Template.leaderboard", (function() {
  var view = this;
  return [ HTML.OL({
    class: "leaderboard"
  }, "\n        ", Blaze.Each(function() {
    return Spacebars.call(view.lookup("players"));
  }, function() {
    return [ "\n            ", Spacebars.include(view.lookupTemplate("player")), "\n        " ];
  }), "\n    "), "\n\n    ", Blaze.If(function() {
    return Spacebars.call(view.lookup("selectedName"));
  }, function() {
    return [ "\n        ", HTML.DIV({
      class: "details"
    }, "\n            ", HTML.DIV({
      class: "name"
    }, Blaze.View("lookup:selectedName", function() {
      return Spacebars.mustache(view.lookup("selectedName"));
    })), "\n            ", HTML.BUTTON({
      class: "inc"
    }, "Add 5 points"), "\n        "), "\n    " ];
  }, function() {
    return [ "\n        ", HTML.DIV({
      class: "message"
    }, "Click a player to select"), "\n    " ];
  }) ];
}));

///////////////////////////////////////////////////////////////////////////////////////////////////

},"player.html":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/player.html                                                                        //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
module.watch(require("./template.player.js"), {
  "*": module.makeNsSetter(true)
});

///////////////////////////////////////////////////////////////////////////////////////////////////

},"template.player.js":function(){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/template.player.js                                                                 //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //

Template.__checkName("player");
Template["player"] = new Template("Template.player", (function() {
  var view = this;
  return HTML.LI({
    class: function() {
      return [ "player ", Spacebars.mustache(view.lookup("selected")) ];
    }
  }, "\n        ", HTML.SPAN({
    class: "name"
  }, Blaze.View("lookup:name", function() {
    return Spacebars.mustache(view.lookup("name"));
  })), "\n        ", HTML.SPAN({
    class: "score"
  }, Blaze.View("lookup:score", function() {
    return Spacebars.mustache(view.lookup("score"));
  })), "\n    ");
}));

///////////////////////////////////////////////////////////////////////////////////////////////////

},"body.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/body.js                                                                            //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
module.watch(require("./body.html"));
///////////////////////////////////////////////////////////////////////////////////////////////////

},"leaderboard.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/leaderboard.js                                                                     //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
var Template;
module.watch(require("meteor/templating"), {
  Template: function (v) {
    Template = v;
  }
}, 0);
var Players;
module.watch(require("../api/players"), {
  Players: function (v) {
    Players = v;
  }
}, 1);
module.watch(require("./leaderboard.html"));
Template.leaderboard.helpers({
  players: function () {
    return Players.find({}, {
      sort: {
        score: -1,
        name: 1
      }
    });
  },
  selectedName: function () {
    var player = Players.findOne(Session.get("selectedPlayer"));
    return player && player.name;
  }
});
Template.leaderboard.events({
  'click .inc': function () {
    Players.update(Session.get("selectedPlayer"), {
      $inc: {
        score: 5
      }
    });
  }
});
///////////////////////////////////////////////////////////////////////////////////////////////////

},"player.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/ui/player.js                                                                          //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
var Template;
module.watch(require("meteor/templating"), {
  Template: function (v) {
    Template = v;
  }
}, 0);
var Players;
module.watch(require("../api/players.js"), {
  Players: function (v) {
    Players = v;
  }
}, 1);
module.watch(require("./player.html"));
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
///////////////////////////////////////////////////////////////////////////////////////////////////

}},"api":{"players.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// imports/api/players.js                                                                        //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
module.export({
  Players: function () {
    return Players;
  }
});
var Mongo;
module.watch(require("meteor/mongo"), {
  Mongo: function (v) {
    Mongo = v;
  }
}, 0);
var Players = new Mongo.Collection("players");
///////////////////////////////////////////////////////////////////////////////////////////////////

}}},"client":{"main.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                               //
// client/main.js                                                                                //
//                                                                                               //
///////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                 //
module.watch(require("../imports/ui/player.js"));
module.watch(require("../imports/ui/leaderboard.js"));
module.watch(require("../imports/ui/body.js"));
///////////////////////////////////////////////////////////////////////////////////////////////////

}}},{
  "extensions": [
    ".js",
    ".json",
    ".html",
    ".css"
  ]
});
require("/client/main.js");
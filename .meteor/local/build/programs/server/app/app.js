var require = meteorInstall({"imports":{"api":{"players.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// imports/api/players.js                                            //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
module.export({
  Players: () => Players
});
let Mongo;
module.watch(require("meteor/mongo"), {
  Mongo(v) {
    Mongo = v;
  }

}, 0);
const Players = new Mongo.Collection("players");
///////////////////////////////////////////////////////////////////////

}}},"server":{"main.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// server/main.js                                                    //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
let Meteor;
module.watch(require("meteor/meteor"), {
  Meteor(v) {
    Meteor = v;
  }

}, 0);
let Random;
module.watch(require("meteor/random"), {
  Random(v) {
    Random = v;
  }

}, 1);
let Players;
module.watch(require("../imports/api/players.js"), {
  Players(v) {
    Players = v;
  }

}, 2);
Meteor.startup(function () {
  if (Players.find().count() === 0) {
    var names = ["Ada Lovelace", "Grace Hopper", "Marie Curie", "Carl Friedrich Gauss", "Nikola Tesla", "Claude Shannon"];

    _.each(names, function (name) {
      Players.insert({
        name: name,
        score: Math.floor(Random.fraction() * 10) * 5
      });
    });
  }
});
///////////////////////////////////////////////////////////////////////

}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});
require("/server/main.js");
//# sourceURL=meteor://💻app/app/app.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvaW1wb3J0cy9hcGkvcGxheWVycy5qcyIsIm1ldGVvcjovL/CfkrthcHAvc2VydmVyL21haW4uanMiXSwibmFtZXMiOlsibW9kdWxlIiwiZXhwb3J0IiwiUGxheWVycyIsIk1vbmdvIiwid2F0Y2giLCJyZXF1aXJlIiwidiIsIkNvbGxlY3Rpb24iLCJNZXRlb3IiLCJSYW5kb20iLCJzdGFydHVwIiwiZmluZCIsImNvdW50IiwibmFtZXMiLCJfIiwiZWFjaCIsIm5hbWUiLCJpbnNlcnQiLCJzY29yZSIsIk1hdGgiLCJmbG9vciIsImZyYWN0aW9uIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBQSxPQUFPQyxNQUFQLENBQWM7QUFBQ0MsV0FBUSxNQUFJQTtBQUFiLENBQWQ7QUFBcUMsSUFBSUMsS0FBSjtBQUFVSCxPQUFPSSxLQUFQLENBQWFDLFFBQVEsY0FBUixDQUFiLEVBQXFDO0FBQUNGLFFBQU1HLENBQU4sRUFBUTtBQUFDSCxZQUFNRyxDQUFOO0FBQVE7O0FBQWxCLENBQXJDLEVBQXlELENBQXpEO0FBRXhDLE1BQU1KLFVBQVUsSUFBSUMsTUFBTUksVUFBVixDQUFxQixTQUFyQixDQUFoQixDOzs7Ozs7Ozs7OztBQ0ZQLElBQUlDLE1BQUo7QUFBV1IsT0FBT0ksS0FBUCxDQUFhQyxRQUFRLGVBQVIsQ0FBYixFQUFzQztBQUFDRyxTQUFPRixDQUFQLEVBQVM7QUFBQ0UsYUFBT0YsQ0FBUDtBQUFTOztBQUFwQixDQUF0QyxFQUE0RCxDQUE1RDtBQUErRCxJQUFJRyxNQUFKO0FBQVdULE9BQU9JLEtBQVAsQ0FBYUMsUUFBUSxlQUFSLENBQWIsRUFBc0M7QUFBQ0ksU0FBT0gsQ0FBUCxFQUFTO0FBQUNHLGFBQU9ILENBQVA7QUFBUzs7QUFBcEIsQ0FBdEMsRUFBNEQsQ0FBNUQ7QUFBK0QsSUFBSUosT0FBSjtBQUFZRixPQUFPSSxLQUFQLENBQWFDLFFBQVEsMkJBQVIsQ0FBYixFQUFrRDtBQUFDSCxVQUFRSSxDQUFSLEVBQVU7QUFBQ0osY0FBUUksQ0FBUjtBQUFVOztBQUF0QixDQUFsRCxFQUEwRSxDQUExRTtBQUloS0UsT0FBT0UsT0FBUCxDQUFlLFlBQVk7QUFDdkIsTUFBSVIsUUFBUVMsSUFBUixHQUFlQyxLQUFmLE9BQTJCLENBQS9CLEVBQWtDO0FBQzlCLFFBQUlDLFFBQVEsQ0FBQyxjQUFELEVBQWlCLGNBQWpCLEVBQWlDLGFBQWpDLEVBQ1Isc0JBRFEsRUFDZ0IsY0FEaEIsRUFDZ0MsZ0JBRGhDLENBQVo7O0FBRUFDLE1BQUVDLElBQUYsQ0FBT0YsS0FBUCxFQUFjLFVBQVVHLElBQVYsRUFBZ0I7QUFDMUJkLGNBQVFlLE1BQVIsQ0FBZTtBQUNYRCxjQUFNQSxJQURLO0FBRVhFLGVBQU9DLEtBQUtDLEtBQUwsQ0FBV1gsT0FBT1ksUUFBUCxLQUFvQixFQUEvQixJQUFxQztBQUZqQyxPQUFmO0FBSUgsS0FMRDtBQU1IO0FBQ0osQ0FYRCxFIiwiZmlsZSI6Ii9hcHAuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBNb25nbyB9IGZyb20gJ21ldGVvci9tb25nbyc7XHJcblxyXG5leHBvcnQgY29uc3QgUGxheWVycyA9IG5ldyBNb25nby5Db2xsZWN0aW9uKFwicGxheWVyc1wiKTsiLCJpbXBvcnQgeyBNZXRlb3IgfSBmcm9tICdtZXRlb3IvbWV0ZW9yJztcbmltcG9ydCB7IFJhbmRvbSB9IGZyb20gJ21ldGVvci9yYW5kb20nO1xuaW1wb3J0IHsgUGxheWVycyB9IGZyb20gJy4uL2ltcG9ydHMvYXBpL3BsYXllcnMuanMnO1xuXG5NZXRlb3Iuc3RhcnR1cChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKFBsYXllcnMuZmluZCgpLmNvdW50KCkgPT09IDApIHtcbiAgICAgICAgdmFyIG5hbWVzID0gW1wiQWRhIExvdmVsYWNlXCIsIFwiR3JhY2UgSG9wcGVyXCIsIFwiTWFyaWUgQ3VyaWVcIixcbiAgICAgICAgICAgIFwiQ2FybCBGcmllZHJpY2ggR2F1c3NcIiwgXCJOaWtvbGEgVGVzbGFcIiwgXCJDbGF1ZGUgU2hhbm5vblwiXTtcbiAgICAgICAgXy5lYWNoKG5hbWVzLCBmdW5jdGlvbiAobmFtZSkge1xuICAgICAgICAgICAgUGxheWVycy5pbnNlcnQoe1xuICAgICAgICAgICAgICAgIG5hbWU6IG5hbWUsXG4gICAgICAgICAgICAgICAgc2NvcmU6IE1hdGguZmxvb3IoUmFuZG9tLmZyYWN0aW9uKCkgKiAxMCkgKiA1XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfVxufSk7Il19

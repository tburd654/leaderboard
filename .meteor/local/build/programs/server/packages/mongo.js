(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var NpmModuleMongodb = Package['npm-mongo'].NpmModuleMongodb;
var NpmModuleMongodbVersion = Package['npm-mongo'].NpmModuleMongodbVersion;
var AllowDeny = Package['allow-deny'].AllowDeny;
var Random = Package.random.Random;
var EJSON = Package.ejson.EJSON;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;
var DDP = Package['ddp-client'].DDP;
var DDPServer = Package['ddp-server'].DDPServer;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var MongoID = Package['mongo-id'].MongoID;
var check = Package.check.check;
var Match = Package.check.Match;
var ECMAScript = Package.ecmascript.ECMAScript;
var _ = Package.underscore._;
var MaxHeap = Package['binary-heap'].MaxHeap;
var MinHeap = Package['binary-heap'].MinHeap;
var MinMaxHeap = Package['binary-heap'].MinMaxHeap;
var Hook = Package['callback-hook'].Hook;
var meteorInstall = Package.modules.meteorInstall;
var meteorBabelHelpers = Package['babel-runtime'].meteorBabelHelpers;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var MongoInternals, MongoTest, MongoConnection, CursorDescription, Cursor, listenAll, forEachTrigger, OPLOG_COLLECTION, idForOp, OplogHandle, ObserveMultiplexer, ObserveHandle, DocFetcher, PollingObserveDriver, OplogObserveDriver, Mongo, selector, callback, options;

var require = meteorInstall({"node_modules":{"meteor":{"mongo":{"mongo_driver.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/mongo_driver.js                                                                                      //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
/**
 * Provide a synchronous Collection API using fibers, backed by
 * MongoDB.  This is only for use on the server, and mostly identical
 * to the client API.
 *
 * NOTE: the public API methods must be run within a fiber. If you call
 * these outside of a fiber they will explode!
 */
var MongoDB = NpmModuleMongodb;

var Future = Npm.require('fibers/future');

MongoInternals = {};
MongoTest = {};
MongoInternals.NpmModules = {
  mongodb: {
    version: NpmModuleMongodbVersion,
    module: MongoDB
  }
}; // Older version of what is now available via
// MongoInternals.NpmModules.mongodb.module.  It was never documented, but
// people do use it.
// XXX COMPAT WITH 1.0.3.2

MongoInternals.NpmModule = MongoDB; // This is used to add or remove EJSON from the beginning of everything nested
// inside an EJSON custom type. It should only be called on pure JSON!

var replaceNames = function (filter, thing) {
  if (typeof thing === "object") {
    if (_.isArray(thing)) {
      return _.map(thing, _.bind(replaceNames, null, filter));
    }

    var ret = {};

    _.each(thing, function (value, key) {
      ret[filter(key)] = replaceNames(filter, value);
    });

    return ret;
  }

  return thing;
}; // Ensure that EJSON.clone keeps a Timestamp as a Timestamp (instead of just
// doing a structural clone).
// XXX how ok is this? what if there are multiple copies of MongoDB loaded?


MongoDB.Timestamp.prototype.clone = function () {
  // Timestamps should be immutable.
  return this;
};

var makeMongoLegal = function (name) {
  return "EJSON" + name;
};

var unmakeMongoLegal = function (name) {
  return name.substr(5);
};

var replaceMongoAtomWithMeteor = function (document) {
  if (document instanceof MongoDB.Binary) {
    var buffer = document.value(true);
    return new Uint8Array(buffer);
  }

  if (document instanceof MongoDB.ObjectID) {
    return new Mongo.ObjectID(document.toHexString());
  }

  if (document["EJSON$type"] && document["EJSON$value"] && _.size(document) === 2) {
    return EJSON.fromJSONValue(replaceNames(unmakeMongoLegal, document));
  }

  if (document instanceof MongoDB.Timestamp) {
    // For now, the Meteor representation of a Mongo timestamp type (not a date!
    // this is a weird internal thing used in the oplog!) is the same as the
    // Mongo representation. We need to do this explicitly or else we would do a
    // structural clone and lose the prototype.
    return document;
  }

  return undefined;
};

var replaceMeteorAtomWithMongo = function (document) {
  if (EJSON.isBinary(document)) {
    // This does more copies than we'd like, but is necessary because
    // MongoDB.BSON only looks like it takes a Uint8Array (and doesn't actually
    // serialize it correctly).
    return new MongoDB.Binary(Buffer.from(document));
  }

  if (document instanceof Mongo.ObjectID) {
    return new MongoDB.ObjectID(document.toHexString());
  }

  if (document instanceof MongoDB.Timestamp) {
    // For now, the Meteor representation of a Mongo timestamp type (not a date!
    // this is a weird internal thing used in the oplog!) is the same as the
    // Mongo representation. We need to do this explicitly or else we would do a
    // structural clone and lose the prototype.
    return document;
  }

  if (EJSON._isCustomType(document)) {
    return replaceNames(makeMongoLegal, EJSON.toJSONValue(document));
  } // It is not ordinarily possible to stick dollar-sign keys into mongo
  // so we don't bother checking for things that need escaping at this time.


  return undefined;
};

var replaceTypes = function (document, atomTransformer) {
  if (typeof document !== 'object' || document === null) return document;
  var replacedTopLevelAtom = atomTransformer(document);
  if (replacedTopLevelAtom !== undefined) return replacedTopLevelAtom;
  var ret = document;

  _.each(document, function (val, key) {
    var valReplaced = replaceTypes(val, atomTransformer);

    if (val !== valReplaced) {
      // Lazy clone. Shallow copy.
      if (ret === document) ret = _.clone(document);
      ret[key] = valReplaced;
    }
  });

  return ret;
};

MongoConnection = function (url, options) {
  var self = this;
  options = options || {};
  self._observeMultiplexers = {};
  self._onFailoverHook = new Hook();
  var mongoOptions = Object.assign({
    // Reconnect on error.
    autoReconnect: true,
    // Try to reconnect forever, instead of stopping after 30 tries (the
    // default), with each attempt separated by 1000ms.
    reconnectTries: Infinity,
    ignoreUndefined: true
  }, Mongo._connectionOptions); // Disable the native parser by default, unless specifically enabled
  // in the mongo URL.
  // - The native driver can cause errors which normally would be
  //   thrown, caught, and handled into segfaults that take down the
  //   whole app.
  // - Binary modules don't yet work when you bundle and move the bundle
  //   to a different platform (aka deploy)
  // We should revisit this after binary npm module support lands.

  if (!/[\?&]native_?[pP]arser=/.test(url)) {
    mongoOptions.native_parser = false;
  } // Internally the oplog connections specify their own poolSize
  // which we don't want to overwrite with any user defined value


  if (_.has(options, 'poolSize')) {
    // If we just set this for "server", replSet will override it. If we just
    // set it for replSet, it will be ignored if we're not using a replSet.
    mongoOptions.poolSize = options.poolSize;
  }

  self.db = null; // We keep track of the ReplSet's primary, so that we can trigger hooks when
  // it changes.  The Node driver's joined callback seems to fire way too
  // often, which is why we need to track it ourselves.

  self._primary = null;
  self._oplogHandle = null;
  self._docFetcher = null;
  var connectFuture = new Future();
  MongoDB.connect(url, mongoOptions, Meteor.bindEnvironment(function (err, db) {
    if (err) {
      throw err;
    } // First, figure out what the current primary is, if any.


    if (db.serverConfig.isMasterDoc) {
      self._primary = db.serverConfig.isMasterDoc.primary;
    }

    db.serverConfig.on('joined', Meteor.bindEnvironment(function (kind, doc) {
      if (kind === 'primary') {
        if (doc.primary !== self._primary) {
          self._primary = doc.primary;

          self._onFailoverHook.each(function (callback) {
            callback();
            return true;
          });
        }
      } else if (doc.me === self._primary) {
        // The thing we thought was primary is now something other than
        // primary.  Forget that we thought it was primary.  (This means
        // that if a server stops being primary and then starts being
        // primary again without another server becoming primary in the
        // middle, we'll correctly count it as a failover.)
        self._primary = null;
      }
    })); // Allow the constructor to return.

    connectFuture['return'](db);
  }, connectFuture.resolver() // onException
  )); // Wait for the connection to be successful; throws on failure.

  self.db = connectFuture.wait();

  if (options.oplogUrl && !Package['disable-oplog']) {
    self._oplogHandle = new OplogHandle(options.oplogUrl, self.db.databaseName);
    self._docFetcher = new DocFetcher(self);
  }
};

MongoConnection.prototype.close = function () {
  var self = this;
  if (!self.db) throw Error("close called before Connection created?"); // XXX probably untested

  var oplogHandle = self._oplogHandle;
  self._oplogHandle = null;
  if (oplogHandle) oplogHandle.stop(); // Use Future.wrap so that errors get thrown. This happens to
  // work even outside a fiber since the 'close' method is not
  // actually asynchronous.

  Future.wrap(_.bind(self.db.close, self.db))(true).wait();
}; // Returns the Mongo Collection object; may yield.


MongoConnection.prototype.rawCollection = function (collectionName) {
  var self = this;
  if (!self.db) throw Error("rawCollection called before Connection created?");
  var future = new Future();
  self.db.collection(collectionName, future.resolver());
  return future.wait();
};

MongoConnection.prototype._createCappedCollection = function (collectionName, byteSize, maxDocuments) {
  var self = this;
  if (!self.db) throw Error("_createCappedCollection called before Connection created?");
  var future = new Future();
  self.db.createCollection(collectionName, {
    capped: true,
    size: byteSize,
    max: maxDocuments
  }, future.resolver());
  future.wait();
}; // This should be called synchronously with a write, to create a
// transaction on the current write fence, if any. After we can read
// the write, and after observers have been notified (or at least,
// after the observer notifiers have added themselves to the write
// fence), you should call 'committed()' on the object returned.


MongoConnection.prototype._maybeBeginWrite = function () {
  var fence = DDPServer._CurrentWriteFence.get();

  if (fence) {
    return fence.beginWrite();
  } else {
    return {
      committed: function () {}
    };
  }
}; // Internal interface: adds a callback which is called when the Mongo primary
// changes. Returns a stop handle.


MongoConnection.prototype._onFailover = function (callback) {
  return this._onFailoverHook.register(callback);
}; //////////// Public API //////////
// The write methods block until the database has confirmed the write (it may
// not be replicated or stable on disk, but one server has confirmed it) if no
// callback is provided. If a callback is provided, then they call the callback
// when the write is confirmed. They return nothing on success, and raise an
// exception on failure.
//
// After making a write (with insert, update, remove), observers are
// notified asynchronously. If you want to receive a callback once all
// of the observer notifications have landed for your write, do the
// writes inside a write fence (set DDPServer._CurrentWriteFence to a new
// _WriteFence, and then set a callback on the write fence.)
//
// Since our execution environment is single-threaded, this is
// well-defined -- a write "has been made" if it's returned, and an
// observer "has been notified" if its callback has returned.


var writeCallback = function (write, refresh, callback) {
  return function (err, result) {
    if (!err) {
      // XXX We don't have to run this on error, right?
      try {
        refresh();
      } catch (refreshErr) {
        if (callback) {
          callback(refreshErr);
          return;
        } else {
          throw refreshErr;
        }
      }
    }

    write.committed();

    if (callback) {
      callback(err, result);
    } else if (err) {
      throw err;
    }
  };
};

var bindEnvironmentForWrite = function (callback) {
  return Meteor.bindEnvironment(callback, "Mongo write");
};

MongoConnection.prototype._insert = function (collection_name, document, callback) {
  var self = this;

  var sendError = function (e) {
    if (callback) return callback(e);
    throw e;
  };

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e._expectedByTest = true;
    sendError(e);
    return;
  }

  if (!(LocalCollection._isPlainObject(document) && !EJSON._isCustomType(document))) {
    sendError(new Error("Only plain objects may be inserted into MongoDB"));
    return;
  }

  var write = self._maybeBeginWrite();

  var refresh = function () {
    Meteor.refresh({
      collection: collection_name,
      id: document._id
    });
  };

  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

  try {
    var collection = self.rawCollection(collection_name);
    collection.insert(replaceTypes(document, replaceMeteorAtomWithMongo), {
      safe: true
    }, callback);
  } catch (err) {
    write.committed();
    throw err;
  }
}; // Cause queries that may be affected by the selector to poll in this write
// fence.


MongoConnection.prototype._refresh = function (collectionName, selector) {
  var refreshKey = {
    collection: collectionName
  }; // If we know which documents we're removing, don't poll queries that are
  // specific to other documents. (Note that multiple notifications here should
  // not cause multiple polls, since all our listener is doing is enqueueing a
  // poll.)

  var specificIds = LocalCollection._idsMatchedBySelector(selector);

  if (specificIds) {
    _.each(specificIds, function (id) {
      Meteor.refresh(_.extend({
        id: id
      }, refreshKey));
    });
  } else {
    Meteor.refresh(refreshKey);
  }
};

MongoConnection.prototype._remove = function (collection_name, selector, callback) {
  var self = this;

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e._expectedByTest = true;

    if (callback) {
      return callback(e);
    } else {
      throw e;
    }
  }

  var write = self._maybeBeginWrite();

  var refresh = function () {
    self._refresh(collection_name, selector);
  };

  callback = bindEnvironmentForWrite(writeCallback(write, refresh, callback));

  try {
    var collection = self.rawCollection(collection_name);

    var wrappedCallback = function (err, driverResult) {
      callback(err, transformResult(driverResult).numberAffected);
    };

    collection.remove(replaceTypes(selector, replaceMeteorAtomWithMongo), {
      safe: true
    }, wrappedCallback);
  } catch (err) {
    write.committed();
    throw err;
  }
};

MongoConnection.prototype._dropCollection = function (collectionName, cb) {
  var self = this;

  var write = self._maybeBeginWrite();

  var refresh = function () {
    Meteor.refresh({
      collection: collectionName,
      id: null,
      dropCollection: true
    });
  };

  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

  try {
    var collection = self.rawCollection(collectionName);
    collection.drop(cb);
  } catch (e) {
    write.committed();
    throw e;
  }
}; // For testing only.  Slightly better than `c.rawDatabase().dropDatabase()`
// because it lets the test's fence wait for it to be complete.


MongoConnection.prototype._dropDatabase = function (cb) {
  var self = this;

  var write = self._maybeBeginWrite();

  var refresh = function () {
    Meteor.refresh({
      dropDatabase: true
    });
  };

  cb = bindEnvironmentForWrite(writeCallback(write, refresh, cb));

  try {
    self.db.dropDatabase(cb);
  } catch (e) {
    write.committed();
    throw e;
  }
};

MongoConnection.prototype._update = function (collection_name, selector, mod, options, callback) {
  var self = this;

  if (!callback && options instanceof Function) {
    callback = options;
    options = null;
  }

  if (collection_name === "___meteor_failure_test_collection") {
    var e = new Error("Failure test");
    e._expectedByTest = true;

    if (callback) {
      return callback(e);
    } else {
      throw e;
    }
  } // explicit safety check. null and undefined can crash the mongo
  // driver. Although the node driver and minimongo do 'support'
  // non-object modifier in that they don't crash, they are not
  // meaningful operations and do not do anything. Defensively throw an
  // error here.


  if (!mod || typeof mod !== 'object') throw new Error("Invalid modifier. Modifier must be an object.");

  if (!(LocalCollection._isPlainObject(mod) && !EJSON._isCustomType(mod))) {
    throw new Error("Only plain objects may be used as replacement" + " documents in MongoDB");
  }

  if (!options) options = {};

  var write = self._maybeBeginWrite();

  var refresh = function () {
    self._refresh(collection_name, selector);
  };

  callback = writeCallback(write, refresh, callback);

  try {
    var collection = self.rawCollection(collection_name);
    var mongoOpts = {
      safe: true
    }; // explictly enumerate options that minimongo supports

    if (options.upsert) mongoOpts.upsert = true;
    if (options.multi) mongoOpts.multi = true; // Lets you get a more more full result from MongoDB. Use with caution:
    // might not work with C.upsert (as opposed to C.update({upsert:true}) or
    // with simulated upsert.

    if (options.fullResult) mongoOpts.fullResult = true;
    var mongoSelector = replaceTypes(selector, replaceMeteorAtomWithMongo);
    var mongoMod = replaceTypes(mod, replaceMeteorAtomWithMongo);

    var isModify = LocalCollection._isModificationMod(mongoMod);

    if (options._forbidReplace && !isModify) {
      var err = new Error("Invalid modifier. Replacements are forbidden.");

      if (callback) {
        return callback(err);
      } else {
        throw err;
      }
    } // We've already run replaceTypes/replaceMeteorAtomWithMongo on
    // selector and mod.  We assume it doesn't matter, as far as
    // the behavior of modifiers is concerned, whether `_modify`
    // is run on EJSON or on mongo-converted EJSON.
    // Run this code up front so that it fails fast if someone uses
    // a Mongo update operator we don't support.


    let knownId;

    if (options.upsert) {
      try {
        let newDoc = LocalCollection._createUpsertDocument(selector, mod);

        knownId = newDoc._id;
      } catch (err) {
        if (callback) {
          return callback(err);
        } else {
          throw err;
        }
      }
    }

    if (options.upsert && !isModify && !knownId && options.insertedId && !(options.insertedId instanceof Mongo.ObjectID && options.generatedId)) {
      // In case of an upsert with a replacement, where there is no _id defined
      // in either the query or the replacement doc, mongo will generate an id itself.
      // Therefore we need this special strategy if we want to control the id ourselves.
      // We don't need to do this when:
      // - This is not a replacement, so we can add an _id to $setOnInsert
      // - The id is defined by query or mod we can just add it to the replacement doc
      // - The user did not specify any id preference and the id is a Mongo ObjectId,
      //     then we can just let Mongo generate the id
      simulateUpsertWithInsertedId(collection, mongoSelector, mongoMod, options, // This callback does not need to be bindEnvironment'ed because
      // simulateUpsertWithInsertedId() wraps it and then passes it through
      // bindEnvironmentForWrite.
      function (error, result) {
        // If we got here via a upsert() call, then options._returnObject will
        // be set and we should return the whole object. Otherwise, we should
        // just return the number of affected docs to match the mongo API.
        if (result && !options._returnObject) {
          callback(error, result.numberAffected);
        } else {
          callback(error, result);
        }
      });
    } else {
      if (options.upsert && !knownId && options.insertedId && isModify) {
        if (!mongoMod.hasOwnProperty('$setOnInsert')) {
          mongoMod.$setOnInsert = {};
        }

        knownId = options.insertedId;
        Object.assign(mongoMod.$setOnInsert, replaceTypes({
          _id: options.insertedId
        }, replaceMeteorAtomWithMongo));
      }

      collection.update(mongoSelector, mongoMod, mongoOpts, bindEnvironmentForWrite(function (err, result) {
        if (!err) {
          var meteorResult = transformResult(result);

          if (meteorResult && options._returnObject) {
            // If this was an upsert() call, and we ended up
            // inserting a new doc and we know its id, then
            // return that id as well.
            if (options.upsert && meteorResult.insertedId) {
              if (knownId) {
                meteorResult.insertedId = knownId;
              } else if (meteorResult.insertedId instanceof MongoDB.ObjectID) {
                meteorResult.insertedId = new Mongo.ObjectID(meteorResult.insertedId.toHexString());
              }
            }

            callback(err, meteorResult);
          } else {
            callback(err, meteorResult.numberAffected);
          }
        } else {
          callback(err);
        }
      }));
    }
  } catch (e) {
    write.committed();
    throw e;
  }
};

var transformResult = function (driverResult) {
  var meteorResult = {
    numberAffected: 0
  };

  if (driverResult) {
    var mongoResult = driverResult.result; // On updates with upsert:true, the inserted values come as a list of
    // upserted values -- even with options.multi, when the upsert does insert,
    // it only inserts one element.

    if (mongoResult.upserted) {
      meteorResult.numberAffected += mongoResult.upserted.length;

      if (mongoResult.upserted.length == 1) {
        meteorResult.insertedId = mongoResult.upserted[0]._id;
      }
    } else {
      meteorResult.numberAffected = mongoResult.n;
    }
  }

  return meteorResult;
};

var NUM_OPTIMISTIC_TRIES = 3; // exposed for testing

MongoConnection._isCannotChangeIdError = function (err) {
  // Mongo 3.2.* returns error as next Object:
  // {name: String, code: Number, errmsg: String}
  // Older Mongo returns:
  // {name: String, code: Number, err: String}
  var error = err.errmsg || err.err; // We don't use the error code here
  // because the error code we observed it producing (16837) appears to be
  // a far more generic error code based on examining the source.

  if (error.indexOf('The _id field cannot be changed') === 0 || error.indexOf("the (immutable) field '_id' was found to have been altered to _id") !== -1) {
    return true;
  }

  return false;
};

var simulateUpsertWithInsertedId = function (collection, selector, mod, options, callback) {
  // STRATEGY: First try doing an upsert with a generated ID.
  // If this throws an error about changing the ID on an existing document
  // then without affecting the database, we know we should probably try
  // an update without the generated ID. If it affected 0 documents,
  // then without affecting the database, we the document that first
  // gave the error is probably removed and we need to try an insert again
  // We go back to step one and repeat.
  // Like all "optimistic write" schemes, we rely on the fact that it's
  // unlikely our writes will continue to be interfered with under normal
  // circumstances (though sufficiently heavy contention with writers
  // disagreeing on the existence of an object will cause writes to fail
  // in theory).
  var insertedId = options.insertedId; // must exist

  var mongoOptsForUpdate = {
    safe: true,
    multi: options.multi
  };
  var mongoOptsForInsert = {
    safe: true,
    upsert: true
  };
  var replacementWithId = Object.assign(replaceTypes({
    _id: insertedId
  }, replaceMeteorAtomWithMongo), mod);
  var tries = NUM_OPTIMISTIC_TRIES;

  var doUpdate = function () {
    tries--;

    if (!tries) {
      callback(new Error("Upsert failed after " + NUM_OPTIMISTIC_TRIES + " tries."));
    } else {
      collection.update(selector, mod, mongoOptsForUpdate, bindEnvironmentForWrite(function (err, result) {
        if (err) {
          callback(err);
        } else if (result && result.result.n != 0) {
          callback(null, {
            numberAffected: result.result.n
          });
        } else {
          doConditionalInsert();
        }
      }));
    }
  };

  var doConditionalInsert = function () {
    collection.update(selector, replacementWithId, mongoOptsForInsert, bindEnvironmentForWrite(function (err, result) {
      if (err) {
        // figure out if this is a
        // "cannot change _id of document" error, and
        // if so, try doUpdate() again, up to 3 times.
        if (MongoConnection._isCannotChangeIdError(err)) {
          doUpdate();
        } else {
          callback(err);
        }
      } else {
        callback(null, {
          numberAffected: result.result.upserted.length,
          insertedId: insertedId
        });
      }
    }));
  };

  doUpdate();
};

_.each(["insert", "update", "remove", "dropCollection", "dropDatabase"], function (method) {
  MongoConnection.prototype[method] = function ()
  /* arguments */
  {
    var self = this;
    return Meteor.wrapAsync(self["_" + method]).apply(self, arguments);
  };
}); // XXX MongoConnection.upsert() does not return the id of the inserted document
// unless you set it explicitly in the selector or modifier (as a replacement
// doc).


MongoConnection.prototype.upsert = function (collectionName, selector, mod, options, callback) {
  var self = this;

  if (typeof options === "function" && !callback) {
    callback = options;
    options = {};
  }

  return self.update(collectionName, selector, mod, _.extend({}, options, {
    upsert: true,
    _returnObject: true
  }), callback);
};

MongoConnection.prototype.find = function (collectionName, selector, options) {
  var self = this;
  if (arguments.length === 1) selector = {};
  return new Cursor(self, new CursorDescription(collectionName, selector, options));
};

MongoConnection.prototype.findOne = function (collection_name, selector, options) {
  var self = this;
  if (arguments.length === 1) selector = {};
  options = options || {};
  options.limit = 1;
  return self.find(collection_name, selector, options).fetch()[0];
}; // We'll actually design an index API later. For now, we just pass through to
// Mongo's, but make it synchronous.


MongoConnection.prototype._ensureIndex = function (collectionName, index, options) {
  var self = this; // We expect this function to be called at startup, not from within a method,
  // so we don't interact with the write fence.

  var collection = self.rawCollection(collectionName);
  var future = new Future();
  var indexName = collection.ensureIndex(index, options, future.resolver());
  future.wait();
};

MongoConnection.prototype._dropIndex = function (collectionName, index) {
  var self = this; // This function is only used by test code, not within a method, so we don't
  // interact with the write fence.

  var collection = self.rawCollection(collectionName);
  var future = new Future();
  var indexName = collection.dropIndex(index, future.resolver());
  future.wait();
}; // CURSORS
// There are several classes which relate to cursors:
//
// CursorDescription represents the arguments used to construct a cursor:
// collectionName, selector, and (find) options.  Because it is used as a key
// for cursor de-dup, everything in it should either be JSON-stringifiable or
// not affect observeChanges output (eg, options.transform functions are not
// stringifiable but do not affect observeChanges).
//
// SynchronousCursor is a wrapper around a MongoDB cursor
// which includes fully-synchronous versions of forEach, etc.
//
// Cursor is the cursor object returned from find(), which implements the
// documented Mongo.Collection cursor API.  It wraps a CursorDescription and a
// SynchronousCursor (lazily: it doesn't contact Mongo until you call a method
// like fetch or forEach on it).
//
// ObserveHandle is the "observe handle" returned from observeChanges. It has a
// reference to an ObserveMultiplexer.
//
// ObserveMultiplexer allows multiple identical ObserveHandles to be driven by a
// single observe driver.
//
// There are two "observe drivers" which drive ObserveMultiplexers:
//   - PollingObserveDriver caches the results of a query and reruns it when
//     necessary.
//   - OplogObserveDriver follows the Mongo operation log to directly observe
//     database changes.
// Both implementations follow the same simple interface: when you create them,
// they start sending observeChanges callbacks (and a ready() invocation) to
// their ObserveMultiplexer, and you stop them by calling their stop() method.


CursorDescription = function (collectionName, selector, options) {
  var self = this;
  self.collectionName = collectionName;
  self.selector = Mongo.Collection._rewriteSelector(selector);
  self.options = options || {};
};

Cursor = function (mongo, cursorDescription) {
  var self = this;
  self._mongo = mongo;
  self._cursorDescription = cursorDescription;
  self._synchronousCursor = null;
};

_.each(['forEach', 'map', 'fetch', 'count'], function (method) {
  Cursor.prototype[method] = function () {
    var self = this; // You can only observe a tailable cursor.

    if (self._cursorDescription.options.tailable) throw new Error("Cannot call " + method + " on a tailable cursor");

    if (!self._synchronousCursor) {
      self._synchronousCursor = self._mongo._createSynchronousCursor(self._cursorDescription, {
        // Make sure that the "self" argument to forEach/map callbacks is the
        // Cursor, not the SynchronousCursor.
        selfForIteration: self,
        useTransform: true
      });
    }

    return self._synchronousCursor[method].apply(self._synchronousCursor, arguments);
  };
}); // Since we don't actually have a "nextObject" interface, there's really no
// reason to have a "rewind" interface.  All it did was make multiple calls
// to fetch/map/forEach return nothing the second time.
// XXX COMPAT WITH 0.8.1


Cursor.prototype.rewind = function () {};

Cursor.prototype.getTransform = function () {
  return this._cursorDescription.options.transform;
}; // When you call Meteor.publish() with a function that returns a Cursor, we need
// to transmute it into the equivalent subscription.  This is the function that
// does that.


Cursor.prototype._publishCursor = function (sub) {
  var self = this;
  var collection = self._cursorDescription.collectionName;
  return Mongo.Collection._publishCursor(self, sub, collection);
}; // Used to guarantee that publish functions return at most one cursor per
// collection. Private, because we might later have cursors that include
// documents from multiple collections somehow.


Cursor.prototype._getCollectionName = function () {
  var self = this;
  return self._cursorDescription.collectionName;
};

Cursor.prototype.observe = function (callbacks) {
  var self = this;
  return LocalCollection._observeFromObserveChanges(self, callbacks);
};

Cursor.prototype.observeChanges = function (callbacks) {
  var self = this;
  var methods = ['addedAt', 'added', 'changedAt', 'changed', 'removedAt', 'removed', 'movedTo'];

  var ordered = LocalCollection._observeChangesCallbacksAreOrdered(callbacks); // XXX: Can we find out if callbacks are from observe?


  var exceptionName = ' observe/observeChanges callback';
  methods.forEach(function (method) {
    if (callbacks[method] && typeof callbacks[method] == "function") {
      callbacks[method] = Meteor.bindEnvironment(callbacks[method], method + exceptionName);
    }
  });
  return self._mongo._observeChanges(self._cursorDescription, ordered, callbacks);
};

MongoConnection.prototype._createSynchronousCursor = function (cursorDescription, options) {
  var self = this;
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');
  var collection = self.rawCollection(cursorDescription.collectionName);
  var cursorOptions = cursorDescription.options;
  var mongoOptions = {
    sort: cursorOptions.sort,
    limit: cursorOptions.limit,
    skip: cursorOptions.skip
  }; // Do we want a tailable cursor (which only works on capped collections)?

  if (cursorOptions.tailable) {
    // We want a tailable cursor...
    mongoOptions.tailable = true; // ... and for the server to wait a bit if any getMore has no data (rather
    // than making us put the relevant sleeps in the client)...

    mongoOptions.awaitdata = true; // ... and to keep querying the server indefinitely rather than just 5 times
    // if there's no more data.

    mongoOptions.numberOfRetries = -1; // And if this is on the oplog collection and the cursor specifies a 'ts',
    // then set the undocumented oplog replay flag, which does a special scan to
    // find the first document (instead of creating an index on ts). This is a
    // very hard-coded Mongo flag which only works on the oplog collection and
    // only works with the ts field.

    if (cursorDescription.collectionName === OPLOG_COLLECTION && cursorDescription.selector.ts) {
      mongoOptions.oplogReplay = true;
    }
  }

  var dbCursor = collection.find(replaceTypes(cursorDescription.selector, replaceMeteorAtomWithMongo), cursorOptions.fields, mongoOptions);

  if (typeof cursorOptions.maxTimeMs !== 'undefined') {
    dbCursor = dbCursor.maxTimeMS(cursorOptions.maxTimeMs);
  }

  if (typeof cursorOptions.hint !== 'undefined') {
    dbCursor = dbCursor.hint(cursorOptions.hint);
  }

  return new SynchronousCursor(dbCursor, cursorDescription, options);
};

var SynchronousCursor = function (dbCursor, cursorDescription, options) {
  var self = this;
  options = _.pick(options || {}, 'selfForIteration', 'useTransform');
  self._dbCursor = dbCursor;
  self._cursorDescription = cursorDescription; // The "self" argument passed to forEach/map callbacks. If we're wrapped
  // inside a user-visible Cursor, we want to provide the outer cursor!

  self._selfForIteration = options.selfForIteration || self;

  if (options.useTransform && cursorDescription.options.transform) {
    self._transform = LocalCollection.wrapTransform(cursorDescription.options.transform);
  } else {
    self._transform = null;
  } // Need to specify that the callback is the first argument to nextObject,
  // since otherwise when we try to call it with no args the driver will
  // interpret "undefined" first arg as an options hash and crash.


  self._synchronousNextObject = Future.wrap(dbCursor.nextObject.bind(dbCursor), 0);
  self._synchronousCount = Future.wrap(dbCursor.count.bind(dbCursor));
  self._visitedIds = new LocalCollection._IdMap();
};

_.extend(SynchronousCursor.prototype, {
  _nextObject: function () {
    var self = this;

    while (true) {
      var doc = self._synchronousNextObject().wait();

      if (!doc) return null;
      doc = replaceTypes(doc, replaceMongoAtomWithMeteor);

      if (!self._cursorDescription.options.tailable && _.has(doc, '_id')) {
        // Did Mongo give us duplicate documents in the same cursor? If so,
        // ignore this one. (Do this before the transform, since transform might
        // return some unrelated value.) We don't do this for tailable cursors,
        // because we want to maintain O(1) memory usage. And if there isn't _id
        // for some reason (maybe it's the oplog), then we don't do this either.
        // (Be careful to do this for falsey but existing _id, though.)
        if (self._visitedIds.has(doc._id)) continue;

        self._visitedIds.set(doc._id, true);
      }

      if (self._transform) doc = self._transform(doc);
      return doc;
    }
  },
  forEach: function (callback, thisArg) {
    var self = this; // Get back to the beginning.

    self._rewind(); // We implement the loop ourself instead of using self._dbCursor.each,
    // because "each" will call its callback outside of a fiber which makes it
    // much more complex to make this function synchronous.


    var index = 0;

    while (true) {
      var doc = self._nextObject();

      if (!doc) return;
      callback.call(thisArg, doc, index++, self._selfForIteration);
    }
  },
  // XXX Allow overlapping callback executions if callback yields.
  map: function (callback, thisArg) {
    var self = this;
    var res = [];
    self.forEach(function (doc, index) {
      res.push(callback.call(thisArg, doc, index, self._selfForIteration));
    });
    return res;
  },
  _rewind: function () {
    var self = this; // known to be synchronous

    self._dbCursor.rewind();

    self._visitedIds = new LocalCollection._IdMap();
  },
  // Mostly usable for tailable cursors.
  close: function () {
    var self = this;

    self._dbCursor.close();
  },
  fetch: function () {
    var self = this;
    return self.map(_.identity);
  },
  count: function (applySkipLimit = false) {
    var self = this;
    return self._synchronousCount(applySkipLimit).wait();
  },
  // This method is NOT wrapped in Cursor.
  getRawObjects: function (ordered) {
    var self = this;

    if (ordered) {
      return self.fetch();
    } else {
      var results = new LocalCollection._IdMap();
      self.forEach(function (doc) {
        results.set(doc._id, doc);
      });
      return results;
    }
  }
});

MongoConnection.prototype.tail = function (cursorDescription, docCallback) {
  var self = this;
  if (!cursorDescription.options.tailable) throw new Error("Can only tail a tailable cursor");

  var cursor = self._createSynchronousCursor(cursorDescription);

  var stopped = false;
  var lastTS;

  var loop = function () {
    var doc = null;

    while (true) {
      if (stopped) return;

      try {
        doc = cursor._nextObject();
      } catch (err) {
        // There's no good way to figure out if this was actually an error
        // from Mongo. Ah well. But either way, we need to retry the cursor
        // (unless the failure was because the observe got stopped).
        doc = null;
      } // Since cursor._nextObject can yield, we need to check again to see if
      // we've been stopped before calling the callback.


      if (stopped) return;

      if (doc) {
        // If a tailable cursor contains a "ts" field, use it to recreate the
        // cursor on error. ("ts" is a standard that Mongo uses internally for
        // the oplog, and there's a special flag that lets you do binary search
        // on it instead of needing to use an index.)
        lastTS = doc.ts;
        docCallback(doc);
      } else {
        var newSelector = _.clone(cursorDescription.selector);

        if (lastTS) {
          newSelector.ts = {
            $gt: lastTS
          };
        }

        cursor = self._createSynchronousCursor(new CursorDescription(cursorDescription.collectionName, newSelector, cursorDescription.options)); // Mongo failover takes many seconds.  Retry in a bit.  (Without this
        // setTimeout, we peg the CPU at 100% and never notice the actual
        // failover.

        Meteor.setTimeout(loop, 100);
        break;
      }
    }
  };

  Meteor.defer(loop);
  return {
    stop: function () {
      stopped = true;
      cursor.close();
    }
  };
};

MongoConnection.prototype._observeChanges = function (cursorDescription, ordered, callbacks) {
  var self = this;

  if (cursorDescription.options.tailable) {
    return self._observeChangesTailable(cursorDescription, ordered, callbacks);
  } // You may not filter out _id when observing changes, because the id is a core
  // part of the observeChanges API.


  if (cursorDescription.options.fields && (cursorDescription.options.fields._id === 0 || cursorDescription.options.fields._id === false)) {
    throw Error("You may not observe a cursor with {fields: {_id: 0}}");
  }

  var observeKey = EJSON.stringify(_.extend({
    ordered: ordered
  }, cursorDescription));
  var multiplexer, observeDriver;
  var firstHandle = false; // Find a matching ObserveMultiplexer, or create a new one. This next block is
  // guaranteed to not yield (and it doesn't call anything that can observe a
  // new query), so no other calls to this function can interleave with it.

  Meteor._noYieldsAllowed(function () {
    if (_.has(self._observeMultiplexers, observeKey)) {
      multiplexer = self._observeMultiplexers[observeKey];
    } else {
      firstHandle = true; // Create a new ObserveMultiplexer.

      multiplexer = new ObserveMultiplexer({
        ordered: ordered,
        onStop: function () {
          delete self._observeMultiplexers[observeKey];
          observeDriver.stop();
        }
      });
      self._observeMultiplexers[observeKey] = multiplexer;
    }
  });

  var observeHandle = new ObserveHandle(multiplexer, callbacks);

  if (firstHandle) {
    var matcher, sorter;

    var canUseOplog = _.all([function () {
      // At a bare minimum, using the oplog requires us to have an oplog, to
      // want unordered callbacks, and to not want a callback on the polls
      // that won't happen.
      return self._oplogHandle && !ordered && !callbacks._testOnlyPollCallback;
    }, function () {
      // We need to be able to compile the selector. Fall back to polling for
      // some newfangled $selector that minimongo doesn't support yet.
      try {
        matcher = new Minimongo.Matcher(cursorDescription.selector);
        return true;
      } catch (e) {
        // XXX make all compilation errors MinimongoError or something
        //     so that this doesn't ignore unrelated exceptions
        return false;
      }
    }, function () {
      // ... and the selector itself needs to support oplog.
      return OplogObserveDriver.cursorSupported(cursorDescription, matcher);
    }, function () {
      // And we need to be able to compile the sort, if any.  eg, can't be
      // {$natural: 1}.
      if (!cursorDescription.options.sort) return true;

      try {
        sorter = new Minimongo.Sorter(cursorDescription.options.sort, {
          matcher: matcher
        });
        return true;
      } catch (e) {
        // XXX make all compilation errors MinimongoError or something
        //     so that this doesn't ignore unrelated exceptions
        return false;
      }
    }], function (f) {
      return f();
    }); // invoke each function


    var driverClass = canUseOplog ? OplogObserveDriver : PollingObserveDriver;
    observeDriver = new driverClass({
      cursorDescription: cursorDescription,
      mongoHandle: self,
      multiplexer: multiplexer,
      ordered: ordered,
      matcher: matcher,
      // ignored by polling
      sorter: sorter,
      // ignored by polling
      _testOnlyPollCallback: callbacks._testOnlyPollCallback
    }); // This field is only set for use in tests.

    multiplexer._observeDriver = observeDriver;
  } // Blocks until the initial adds have been sent.


  multiplexer.addHandleAndSendInitialAdds(observeHandle);
  return observeHandle;
}; // Listen for the invalidation messages that will trigger us to poll the
// database for changes. If this selector specifies specific IDs, specify them
// here, so that updates to different specific IDs don't cause us to poll.
// listenCallback is the same kind of (notification, complete) callback passed
// to InvalidationCrossbar.listen.


listenAll = function (cursorDescription, listenCallback) {
  var listeners = [];
  forEachTrigger(cursorDescription, function (trigger) {
    listeners.push(DDPServer._InvalidationCrossbar.listen(trigger, listenCallback));
  });
  return {
    stop: function () {
      _.each(listeners, function (listener) {
        listener.stop();
      });
    }
  };
};

forEachTrigger = function (cursorDescription, triggerCallback) {
  var key = {
    collection: cursorDescription.collectionName
  };

  var specificIds = LocalCollection._idsMatchedBySelector(cursorDescription.selector);

  if (specificIds) {
    _.each(specificIds, function (id) {
      triggerCallback(_.extend({
        id: id
      }, key));
    });

    triggerCallback(_.extend({
      dropCollection: true,
      id: null
    }, key));
  } else {
    triggerCallback(key);
  } // Everyone cares about the database being dropped.


  triggerCallback({
    dropDatabase: true
  });
}; // observeChanges for tailable cursors on capped collections.
//
// Some differences from normal cursors:
//   - Will never produce anything other than 'added' or 'addedBefore'. If you
//     do update a document that has already been produced, this will not notice
//     it.
//   - If you disconnect and reconnect from Mongo, it will essentially restart
//     the query, which will lead to duplicate results. This is pretty bad,
//     but if you include a field called 'ts' which is inserted as
//     new MongoInternals.MongoTimestamp(0, 0) (which is initialized to the
//     current Mongo-style timestamp), we'll be able to find the place to
//     restart properly. (This field is specifically understood by Mongo with an
//     optimization which allows it to find the right place to start without
//     an index on ts. It's how the oplog works.)
//   - No callbacks are triggered synchronously with the call (there's no
//     differentiation between "initial data" and "later changes"; everything
//     that matches the query gets sent asynchronously).
//   - De-duplication is not implemented.
//   - Does not yet interact with the write fence. Probably, this should work by
//     ignoring removes (which don't work on capped collections) and updates
//     (which don't affect tailable cursors), and just keeping track of the ID
//     of the inserted object, and closing the write fence once you get to that
//     ID (or timestamp?).  This doesn't work well if the document doesn't match
//     the query, though.  On the other hand, the write fence can close
//     immediately if it does not match the query. So if we trust minimongo
//     enough to accurately evaluate the query against the write fence, we
//     should be able to do this...  Of course, minimongo doesn't even support
//     Mongo Timestamps yet.


MongoConnection.prototype._observeChangesTailable = function (cursorDescription, ordered, callbacks) {
  var self = this; // Tailable cursors only ever call added/addedBefore callbacks, so it's an
  // error if you didn't provide them.

  if (ordered && !callbacks.addedBefore || !ordered && !callbacks.added) {
    throw new Error("Can't observe an " + (ordered ? "ordered" : "unordered") + " tailable cursor without a " + (ordered ? "addedBefore" : "added") + " callback");
  }

  return self.tail(cursorDescription, function (doc) {
    var id = doc._id;
    delete doc._id; // The ts is an implementation detail. Hide it.

    delete doc.ts;

    if (ordered) {
      callbacks.addedBefore(id, doc, null);
    } else {
      callbacks.added(id, doc);
    }
  });
}; // XXX We probably need to find a better way to expose this. Right now
// it's only used by tests, but in fact you need it in normal
// operation to interact with capped collections.


MongoInternals.MongoTimestamp = MongoDB.Timestamp;
MongoInternals.Connection = MongoConnection;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"oplog_tailing.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/oplog_tailing.js                                                                                     //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

OPLOG_COLLECTION = 'oplog.rs';
var TOO_FAR_BEHIND = process.env.METEOR_OPLOG_TOO_FAR_BEHIND || 2000;

var showTS = function (ts) {
  return "Timestamp(" + ts.getHighBits() + ", " + ts.getLowBits() + ")";
};

idForOp = function (op) {
  if (op.op === 'd') return op.o._id;else if (op.op === 'i') return op.o._id;else if (op.op === 'u') return op.o2._id;else if (op.op === 'c') throw Error("Operator 'c' doesn't supply an object with id: " + EJSON.stringify(op));else throw Error("Unknown op: " + EJSON.stringify(op));
};

OplogHandle = function (oplogUrl, dbName) {
  var self = this;
  self._oplogUrl = oplogUrl;
  self._dbName = dbName;
  self._oplogLastEntryConnection = null;
  self._oplogTailConnection = null;
  self._stopped = false;
  self._tailHandle = null;
  self._readyFuture = new Future();
  self._crossbar = new DDPServer._Crossbar({
    factPackage: "mongo-livedata",
    factName: "oplog-watchers"
  });
  self._baseOplogSelector = {
    ns: new RegExp('^' + Meteor._escapeRegExp(self._dbName) + '\\.'),
    $or: [{
      op: {
        $in: ['i', 'u', 'd']
      }
    }, // drop collection
    {
      op: 'c',
      'o.drop': {
        $exists: true
      }
    }, {
      op: 'c',
      'o.dropDatabase': 1
    }]
  }; // Data structures to support waitUntilCaughtUp(). Each oplog entry has a
  // MongoTimestamp object on it (which is not the same as a Date --- it's a
  // combination of time and an incrementing counter; see
  // http://docs.mongodb.org/manual/reference/bson-types/#timestamps).
  //
  // _catchingUpFutures is an array of {ts: MongoTimestamp, future: Future}
  // objects, sorted by ascending timestamp. _lastProcessedTS is the
  // MongoTimestamp of the last oplog entry we've processed.
  //
  // Each time we call waitUntilCaughtUp, we take a peek at the final oplog
  // entry in the db.  If we've already processed it (ie, it is not greater than
  // _lastProcessedTS), waitUntilCaughtUp immediately returns. Otherwise,
  // waitUntilCaughtUp makes a new Future and inserts it along with the final
  // timestamp entry that it read, into _catchingUpFutures. waitUntilCaughtUp
  // then waits on that future, which is resolved once _lastProcessedTS is
  // incremented to be past its timestamp by the worker fiber.
  //
  // XXX use a priority queue or something else that's faster than an array

  self._catchingUpFutures = [];
  self._lastProcessedTS = null;
  self._onSkippedEntriesHook = new Hook({
    debugPrintExceptions: "onSkippedEntries callback"
  });
  self._entryQueue = new Meteor._DoubleEndedQueue();
  self._workerActive = false;

  self._startTailing();
};

_.extend(OplogHandle.prototype, {
  stop: function () {
    var self = this;
    if (self._stopped) return;
    self._stopped = true;
    if (self._tailHandle) self._tailHandle.stop(); // XXX should close connections too
  },
  onOplogEntry: function (trigger, callback) {
    var self = this;
    if (self._stopped) throw new Error("Called onOplogEntry on stopped handle!"); // Calling onOplogEntry requires us to wait for the tailing to be ready.

    self._readyFuture.wait();

    var originalCallback = callback;
    callback = Meteor.bindEnvironment(function (notification) {
      // XXX can we avoid this clone by making oplog.js careful?
      originalCallback(EJSON.clone(notification));
    }, function (err) {
      Meteor._debug("Error in oplog callback", err.stack);
    });

    var listenHandle = self._crossbar.listen(trigger, callback);

    return {
      stop: function () {
        listenHandle.stop();
      }
    };
  },
  // Register a callback to be invoked any time we skip oplog entries (eg,
  // because we are too far behind).
  onSkippedEntries: function (callback) {
    var self = this;
    if (self._stopped) throw new Error("Called onSkippedEntries on stopped handle!");
    return self._onSkippedEntriesHook.register(callback);
  },
  // Calls `callback` once the oplog has been processed up to a point that is
  // roughly "now": specifically, once we've processed all ops that are
  // currently visible.
  // XXX become convinced that this is actually safe even if oplogConnection
  // is some kind of pool
  waitUntilCaughtUp: function () {
    var self = this;
    if (self._stopped) throw new Error("Called waitUntilCaughtUp on stopped handle!"); // Calling waitUntilCaughtUp requries us to wait for the oplog connection to
    // be ready.

    self._readyFuture.wait();

    var lastEntry;

    while (!self._stopped) {
      // We need to make the selector at least as restrictive as the actual
      // tailing selector (ie, we need to specify the DB name) or else we might
      // find a TS that won't show up in the actual tail stream.
      try {
        lastEntry = self._oplogLastEntryConnection.findOne(OPLOG_COLLECTION, self._baseOplogSelector, {
          fields: {
            ts: 1
          },
          sort: {
            $natural: -1
          }
        });
        break;
      } catch (e) {
        // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.
        Meteor._debug("Got exception while reading last entry: " + e);

        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped) return;

    if (!lastEntry) {
      // Really, nothing in the oplog? Well, we've processed everything.
      return;
    }

    var ts = lastEntry.ts;
    if (!ts) throw Error("oplog entry without ts: " + EJSON.stringify(lastEntry));

    if (self._lastProcessedTS && ts.lessThanOrEqual(self._lastProcessedTS)) {
      // We've already caught up to here.
      return;
    } // Insert the future into our list. Almost always, this will be at the end,
    // but it's conceivable that if we fail over from one primary to another,
    // the oplog entries we see will go backwards.


    var insertAfter = self._catchingUpFutures.length;

    while (insertAfter - 1 > 0 && self._catchingUpFutures[insertAfter - 1].ts.greaterThan(ts)) {
      insertAfter--;
    }

    var f = new Future();

    self._catchingUpFutures.splice(insertAfter, 0, {
      ts: ts,
      future: f
    });

    f.wait();
  },
  _startTailing: function () {
    var self = this; // First, make sure that we're talking to the local database.

    var mongodbUri = Npm.require('mongodb-uri');

    if (mongodbUri.parse(self._oplogUrl).database !== 'local') {
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " + "a Mongo replica set");
    } // We make two separate connections to Mongo. The Node Mongo driver
    // implements a naive round-robin connection pool: each "connection" is a
    // pool of several (5 by default) TCP connections, and each request is
    // rotated through the pools. Tailable cursor queries block on the server
    // until there is some data to return (or until a few seconds have
    // passed). So if the connection pool used for tailing cursors is the same
    // pool used for other queries, the other queries will be delayed by seconds
    // 1/5 of the time.
    //
    // The tail connection will only ever be running a single tail command, so
    // it only needs to make one underlying TCP connection.


    self._oplogTailConnection = new MongoConnection(self._oplogUrl, {
      poolSize: 1
    }); // XXX better docs, but: it's to get monotonic results
    // XXX is it safe to say "if there's an in flight query, just use its
    //     results"? I don't think so but should consider that

    self._oplogLastEntryConnection = new MongoConnection(self._oplogUrl, {
      poolSize: 1
    }); // Now, make sure that there actually is a repl set here. If not, oplog
    // tailing won't ever find anything!
    // More on the isMasterDoc
    // https://docs.mongodb.com/manual/reference/command/isMaster/

    var f = new Future();

    self._oplogLastEntryConnection.db.admin().command({
      ismaster: 1
    }, f.resolver());

    var isMasterDoc = f.wait();

    if (!(isMasterDoc && isMasterDoc.setName)) {
      throw Error("$MONGO_OPLOG_URL must be set to the 'local' database of " + "a Mongo replica set");
    } // Find the last oplog entry.


    var lastOplogEntry = self._oplogLastEntryConnection.findOne(OPLOG_COLLECTION, {}, {
      sort: {
        $natural: -1
      },
      fields: {
        ts: 1
      }
    });

    var oplogSelector = _.clone(self._baseOplogSelector);

    if (lastOplogEntry) {
      // Start after the last entry that currently exists.
      oplogSelector.ts = {
        $gt: lastOplogEntry.ts
      }; // If there are any calls to callWhenProcessedLatest before any other
      // oplog entries show up, allow callWhenProcessedLatest to call its
      // callback immediately.

      self._lastProcessedTS = lastOplogEntry.ts;
    }

    var cursorDescription = new CursorDescription(OPLOG_COLLECTION, oplogSelector, {
      tailable: true
    });
    self._tailHandle = self._oplogTailConnection.tail(cursorDescription, function (doc) {
      self._entryQueue.push(doc);

      self._maybeStartWorker();
    });

    self._readyFuture.return();
  },
  _maybeStartWorker: function () {
    var self = this;
    if (self._workerActive) return;
    self._workerActive = true;
    Meteor.defer(function () {
      try {
        while (!self._stopped && !self._entryQueue.isEmpty()) {
          // Are we too far behind? Just tell our observers that they need to
          // repoll, and drop our queue.
          if (self._entryQueue.length > TOO_FAR_BEHIND) {
            var lastEntry = self._entryQueue.pop();

            self._entryQueue.clear();

            self._onSkippedEntriesHook.each(function (callback) {
              callback();
              return true;
            }); // Free any waitUntilCaughtUp() calls that were waiting for us to
            // pass something that we just skipped.


            self._setLastProcessedTS(lastEntry.ts);

            continue;
          }

          var doc = self._entryQueue.shift();

          if (!(doc.ns && doc.ns.length > self._dbName.length + 1 && doc.ns.substr(0, self._dbName.length + 1) === self._dbName + '.')) {
            throw new Error("Unexpected ns");
          }

          var trigger = {
            collection: doc.ns.substr(self._dbName.length + 1),
            dropCollection: false,
            dropDatabase: false,
            op: doc
          }; // Is it a special command and the collection name is hidden somewhere
          // in operator?

          if (trigger.collection === "$cmd") {
            if (doc.o.dropDatabase) {
              delete trigger.collection;
              trigger.dropDatabase = true;
            } else if (_.has(doc.o, 'drop')) {
              trigger.collection = doc.o.drop;
              trigger.dropCollection = true;
              trigger.id = null;
            } else {
              throw Error("Unknown command " + JSON.stringify(doc));
            }
          } else {
            // All other ops have an id.
            trigger.id = idForOp(doc);
          }

          self._crossbar.fire(trigger); // Now that we've processed this operation, process pending
          // sequencers.


          if (!doc.ts) throw Error("oplog entry without ts: " + EJSON.stringify(doc));

          self._setLastProcessedTS(doc.ts);
        }
      } finally {
        self._workerActive = false;
      }
    });
  },
  _setLastProcessedTS: function (ts) {
    var self = this;
    self._lastProcessedTS = ts;

    while (!_.isEmpty(self._catchingUpFutures) && self._catchingUpFutures[0].ts.lessThanOrEqual(self._lastProcessedTS)) {
      var sequencer = self._catchingUpFutures.shift();

      sequencer.future.return();
    }
  },
  //Methods used on tests to dinamically change TOO_FAR_BEHIND
  _defineTooFarBehind: function (value) {
    TOO_FAR_BEHIND = value;
  },
  _resetTooFarBehind: function () {
    TOO_FAR_BEHIND = process.env.METEOR_OPLOG_TOO_FAR_BEHIND || 2000;
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"observe_multiplex.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/observe_multiplex.js                                                                                 //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

ObserveMultiplexer = function (options) {
  var self = this;
  if (!options || !_.has(options, 'ordered')) throw Error("must specified ordered");
  Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-multiplexers", 1);
  self._ordered = options.ordered;

  self._onStop = options.onStop || function () {};

  self._queue = new Meteor._SynchronousQueue();
  self._handles = {};
  self._readyFuture = new Future();
  self._cache = new LocalCollection._CachingChangeObserver({
    ordered: options.ordered
  }); // Number of addHandleAndSendInitialAdds tasks scheduled but not yet
  // running. removeHandle uses this to know if it's time to call the onStop
  // callback.

  self._addHandleTasksScheduledButNotPerformed = 0;

  _.each(self.callbackNames(), function (callbackName) {
    self[callbackName] = function ()
    /* ... */
    {
      self._applyCallback(callbackName, _.toArray(arguments));
    };
  });
};

_.extend(ObserveMultiplexer.prototype, {
  addHandleAndSendInitialAdds: function (handle) {
    var self = this; // Check this before calling runTask (even though runTask does the same
    // check) so that we don't leak an ObserveMultiplexer on error by
    // incrementing _addHandleTasksScheduledButNotPerformed and never
    // decrementing it.

    if (!self._queue.safeToRunTask()) throw new Error("Can't call observeChanges from an observe callback on the same query");
    ++self._addHandleTasksScheduledButNotPerformed;
    Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-handles", 1);

    self._queue.runTask(function () {
      self._handles[handle._id] = handle; // Send out whatever adds we have so far (whether or not we the
      // multiplexer is ready).

      self._sendAdds(handle);

      --self._addHandleTasksScheduledButNotPerformed;
    }); // *outside* the task, since otherwise we'd deadlock


    self._readyFuture.wait();
  },
  // Remove an observe handle. If it was the last observe handle, call the
  // onStop callback; you cannot add any more observe handles after this.
  //
  // This is not synchronized with polls and handle additions: this means that
  // you can safely call it from within an observe callback, but it also means
  // that we have to be careful when we iterate over _handles.
  removeHandle: function (id) {
    var self = this; // This should not be possible: you can only call removeHandle by having
    // access to the ObserveHandle, which isn't returned to user code until the
    // multiplex is ready.

    if (!self._ready()) throw new Error("Can't remove handles until the multiplex is ready");
    delete self._handles[id];
    Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-handles", -1);

    if (_.isEmpty(self._handles) && self._addHandleTasksScheduledButNotPerformed === 0) {
      self._stop();
    }
  },
  _stop: function (options) {
    var self = this;
    options = options || {}; // It shouldn't be possible for us to stop when all our handles still
    // haven't been returned from observeChanges!

    if (!self._ready() && !options.fromQueryError) throw Error("surprising _stop: not ready"); // Call stop callback (which kills the underlying process which sends us
    // callbacks and removes us from the connection's dictionary).

    self._onStop();

    Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-multiplexers", -1); // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop
    // callback should make our connection forget about us).

    self._handles = null;
  },
  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding
  // adds have been processed. Does not block.
  ready: function () {
    var self = this;

    self._queue.queueTask(function () {
      if (self._ready()) throw Error("can't make ObserveMultiplex ready twice!");

      self._readyFuture.return();
    });
  },
  // If trying to execute the query results in an error, call this. This is
  // intended for permanent errors, not transient network errors that could be
  // fixed. It should only be called before ready(), because if you called ready
  // that meant that you managed to run the query once. It will stop this
  // ObserveMultiplex and cause addHandleAndSendInitialAdds calls (and thus
  // observeChanges calls) to throw the error.
  queryError: function (err) {
    var self = this;

    self._queue.runTask(function () {
      if (self._ready()) throw Error("can't claim query has an error after it worked!");

      self._stop({
        fromQueryError: true
      });

      self._readyFuture.throw(err);
    });
  },
  // Calls "cb" once the effects of all "ready", "addHandleAndSendInitialAdds"
  // and observe callbacks which came before this call have been propagated to
  // all handles. "ready" must have already been called on this multiplexer.
  onFlush: function (cb) {
    var self = this;

    self._queue.queueTask(function () {
      if (!self._ready()) throw Error("only call onFlush on a multiplexer that will be ready");
      cb();
    });
  },
  callbackNames: function () {
    var self = this;
    if (self._ordered) return ["addedBefore", "changed", "movedBefore", "removed"];else return ["added", "changed", "removed"];
  },
  _ready: function () {
    return this._readyFuture.isResolved();
  },
  _applyCallback: function (callbackName, args) {
    var self = this;

    self._queue.queueTask(function () {
      // If we stopped in the meantime, do nothing.
      if (!self._handles) return; // First, apply the change to the cache.
      // XXX We could make applyChange callbacks promise not to hang on to any
      // state from their arguments (assuming that their supplied callbacks
      // don't) and skip this clone. Currently 'changed' hangs on to state
      // though.

      self._cache.applyChange[callbackName].apply(null, EJSON.clone(args)); // If we haven't finished the initial adds, then we should only be getting
      // adds.


      if (!self._ready() && callbackName !== 'added' && callbackName !== 'addedBefore') {
        throw new Error("Got " + callbackName + " during initial adds");
      } // Now multiplex the callbacks out to all observe handles. It's OK if
      // these calls yield; since we're inside a task, no other use of our queue
      // can continue until these are done. (But we do have to be careful to not
      // use a handle that got removed, because removeHandle does not use the
      // queue; thus, we iterate over an array of keys that we control.)


      _.each(_.keys(self._handles), function (handleId) {
        var handle = self._handles && self._handles[handleId];
        if (!handle) return;
        var callback = handle['_' + callbackName]; // clone arguments so that callbacks can mutate their arguments

        callback && callback.apply(null, EJSON.clone(args));
      });
    });
  },
  // Sends initial adds to a handle. It should only be called from within a task
  // (the task that is processing the addHandleAndSendInitialAdds call). It
  // synchronously invokes the handle's added or addedBefore; there's no need to
  // flush the queue afterwards to ensure that the callbacks get out.
  _sendAdds: function (handle) {
    var self = this;
    if (self._queue.safeToRunTask()) throw Error("_sendAdds may only be called from within a task!");
    var add = self._ordered ? handle._addedBefore : handle._added;
    if (!add) return; // note: docs may be an _IdMap or an OrderedDict

    self._cache.docs.forEach(function (doc, id) {
      if (!_.has(self._handles, handle._id)) throw Error("handle got removed before sending initial adds!");
      var fields = EJSON.clone(doc);
      delete fields._id;
      if (self._ordered) add(id, fields, null); // we're going in order, so add at end
      else add(id, fields);
    });
  }
});

var nextObserveHandleId = 1;

ObserveHandle = function (multiplexer, callbacks) {
  var self = this; // The end user is only supposed to call stop().  The other fields are
  // accessible to the multiplexer, though.

  self._multiplexer = multiplexer;

  _.each(multiplexer.callbackNames(), function (name) {
    if (callbacks[name]) {
      self['_' + name] = callbacks[name];
    } else if (name === "addedBefore" && callbacks.added) {
      // Special case: if you specify "added" and "movedBefore", you get an
      // ordered observe where for some reason you don't get ordering data on
      // the adds.  I dunno, we wrote tests for it, there must have been a
      // reason.
      self._addedBefore = function (id, fields, before) {
        callbacks.added(id, fields);
      };
    }
  });

  self._stopped = false;
  self._id = nextObserveHandleId++;
};

ObserveHandle.prototype.stop = function () {
  var self = this;
  if (self._stopped) return;
  self._stopped = true;

  self._multiplexer.removeHandle(self._id);
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"doc_fetcher.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/doc_fetcher.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Fiber = Npm.require('fibers');

var Future = Npm.require('fibers/future');

DocFetcher = function (mongoConnection) {
  var self = this;
  self._mongoConnection = mongoConnection; // Map from cache key -> [callback]

  self._callbacksForCacheKey = {};
};

_.extend(DocFetcher.prototype, {
  // Fetches document "id" from collectionName, returning it or null if not
  // found.
  //
  // If you make multiple calls to fetch() with the same cacheKey (a string),
  // DocFetcher may assume that they all return the same document. (It does
  // not check to see if collectionName/id match.)
  //
  // You may assume that callback is never called synchronously (and in fact
  // OplogObserveDriver does so).
  fetch: function (collectionName, id, cacheKey, callback) {
    var self = this;
    check(collectionName, String); // id is some sort of scalar

    check(cacheKey, String); // If there's already an in-progress fetch for this cache key, yield until
    // it's done and return whatever it returns.

    if (_.has(self._callbacksForCacheKey, cacheKey)) {
      self._callbacksForCacheKey[cacheKey].push(callback);

      return;
    }

    var callbacks = self._callbacksForCacheKey[cacheKey] = [callback];
    Fiber(function () {
      try {
        var doc = self._mongoConnection.findOne(collectionName, {
          _id: id
        }) || null; // Return doc to all relevant callbacks. Note that this array can
        // continue to grow during callback excecution.

        while (!_.isEmpty(callbacks)) {
          // Clone the document so that the various calls to fetch don't return
          // objects that are intertwingled with each other. Clone before
          // popping the future, so that if clone throws, the error gets passed
          // to the next callback.
          var clonedDoc = EJSON.clone(doc);
          callbacks.pop()(null, clonedDoc);
        }
      } catch (e) {
        while (!_.isEmpty(callbacks)) {
          callbacks.pop()(e);
        }
      } finally {
        // XXX consider keeping the doc around for a period of time before
        // removing from the cache
        delete self._callbacksForCacheKey[cacheKey];
      }
    }).run();
  }
});

MongoTest.DocFetcher = DocFetcher;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"polling_observe_driver.js":function(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/polling_observe_driver.js                                                                            //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
PollingObserveDriver = function (options) {
  var self = this;
  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._ordered = options.ordered;
  self._multiplexer = options.multiplexer;
  self._stopCallbacks = [];
  self._stopped = false;
  self._synchronousCursor = self._mongoHandle._createSynchronousCursor(self._cursorDescription); // previous results snapshot.  on each poll cycle, diffs against
  // results drives the callbacks.

  self._results = null; // The number of _pollMongo calls that have been added to self._taskQueue but
  // have not started running. Used to make sure we never schedule more than one
  // _pollMongo (other than possibly the one that is currently running). It's
  // also used by _suspendPolling to pretend there's a poll scheduled. Usually,
  // it's either 0 (for "no polls scheduled other than maybe one currently
  // running") or 1 (for "a poll scheduled that isn't running yet"), but it can
  // also be 2 if incremented by _suspendPolling.

  self._pollsScheduledButNotStarted = 0;
  self._pendingWrites = []; // people to notify when polling completes
  // Make sure to create a separately throttled function for each
  // PollingObserveDriver object.

  self._ensurePollIsScheduled = _.throttle(self._unthrottledEnsurePollIsScheduled, self._cursorDescription.options.pollingThrottleMs || 50
  /* ms */
  ); // XXX figure out if we still need a queue

  self._taskQueue = new Meteor._SynchronousQueue();
  var listenersHandle = listenAll(self._cursorDescription, function (notification) {
    // When someone does a transaction that might affect us, schedule a poll
    // of the database. If that transaction happens inside of a write fence,
    // block the fence until we've polled and notified observers.
    var fence = DDPServer._CurrentWriteFence.get();

    if (fence) self._pendingWrites.push(fence.beginWrite()); // Ensure a poll is scheduled... but if we already know that one is,
    // don't hit the throttled _ensurePollIsScheduled function (which might
    // lead to us calling it unnecessarily in <pollingThrottleMs> ms).

    if (self._pollsScheduledButNotStarted === 0) self._ensurePollIsScheduled();
  });

  self._stopCallbacks.push(function () {
    listenersHandle.stop();
  }); // every once and a while, poll even if we don't think we're dirty, for
  // eventual consistency with database writes from outside the Meteor
  // universe.
  //
  // For testing, there's an undocumented callback argument to observeChanges
  // which disables time-based polling and gets called at the beginning of each
  // poll.


  if (options._testOnlyPollCallback) {
    self._testOnlyPollCallback = options._testOnlyPollCallback;
  } else {
    var pollingInterval = self._cursorDescription.options.pollingIntervalMs || self._cursorDescription.options._pollingInterval || // COMPAT with 1.2
    10 * 1000;
    var intervalHandle = Meteor.setInterval(_.bind(self._ensurePollIsScheduled, self), pollingInterval);

    self._stopCallbacks.push(function () {
      Meteor.clearInterval(intervalHandle);
    });
  } // Make sure we actually poll soon!


  self._unthrottledEnsurePollIsScheduled();

  Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-drivers-polling", 1);
};

_.extend(PollingObserveDriver.prototype, {
  // This is always called through _.throttle (except once at startup).
  _unthrottledEnsurePollIsScheduled: function () {
    var self = this;
    if (self._pollsScheduledButNotStarted > 0) return;
    ++self._pollsScheduledButNotStarted;

    self._taskQueue.queueTask(function () {
      self._pollMongo();
    });
  },
  // test-only interface for controlling polling.
  //
  // _suspendPolling blocks until any currently running and scheduled polls are
  // done, and prevents any further polls from being scheduled. (new
  // ObserveHandles can be added and receive their initial added callbacks,
  // though.)
  //
  // _resumePolling immediately polls, and allows further polls to occur.
  _suspendPolling: function () {
    var self = this; // Pretend that there's another poll scheduled (which will prevent
    // _ensurePollIsScheduled from queueing any more polls).

    ++self._pollsScheduledButNotStarted; // Now block until all currently running or scheduled polls are done.

    self._taskQueue.runTask(function () {}); // Confirm that there is only one "poll" (the fake one we're pretending to
    // have) scheduled.


    if (self._pollsScheduledButNotStarted !== 1) throw new Error("_pollsScheduledButNotStarted is " + self._pollsScheduledButNotStarted);
  },
  _resumePolling: function () {
    var self = this; // We should be in the same state as in the end of _suspendPolling.

    if (self._pollsScheduledButNotStarted !== 1) throw new Error("_pollsScheduledButNotStarted is " + self._pollsScheduledButNotStarted); // Run a poll synchronously (which will counteract the
    // ++_pollsScheduledButNotStarted from _suspendPolling).

    self._taskQueue.runTask(function () {
      self._pollMongo();
    });
  },
  _pollMongo: function () {
    var self = this;
    --self._pollsScheduledButNotStarted;
    if (self._stopped) return;
    var first = false;
    var newResults;
    var oldResults = self._results;

    if (!oldResults) {
      first = true; // XXX maybe use OrderedDict instead?

      oldResults = self._ordered ? [] : new LocalCollection._IdMap();
    }

    self._testOnlyPollCallback && self._testOnlyPollCallback(); // Save the list of pending writes which this round will commit.

    var writesForCycle = self._pendingWrites;
    self._pendingWrites = []; // Get the new query results. (This yields.)

    try {
      newResults = self._synchronousCursor.getRawObjects(self._ordered);
    } catch (e) {
      if (first && typeof e.code === 'number') {
        // This is an error document sent to us by mongod, not a connection
        // error generated by the client. And we've never seen this query work
        // successfully. Probably it's a bad selector or something, so we should
        // NOT retry. Instead, we should halt the observe (which ends up calling
        // `stop` on us).
        self._multiplexer.queryError(new Error("Exception while polling query " + JSON.stringify(self._cursorDescription) + ": " + e.message));

        return;
      } // getRawObjects can throw if we're having trouble talking to the
      // database.  That's fine --- we will repoll later anyway. But we should
      // make sure not to lose track of this cycle's writes.
      // (It also can throw if there's just something invalid about this query;
      // unfortunately the ObserveDriver API doesn't provide a good way to
      // "cancel" the observe from the inside in this case.


      Array.prototype.push.apply(self._pendingWrites, writesForCycle);

      Meteor._debug("Exception while polling query " + JSON.stringify(self._cursorDescription) + ": " + e.stack);

      return;
    } // Run diffs.


    if (!self._stopped) {
      LocalCollection._diffQueryChanges(self._ordered, oldResults, newResults, self._multiplexer);
    } // Signals the multiplexer to allow all observeChanges calls that share this
    // multiplexer to return. (This happens asynchronously, via the
    // multiplexer's queue.)


    if (first) self._multiplexer.ready(); // Replace self._results atomically.  (This assignment is what makes `first`
    // stay through on the next cycle, so we've waited until after we've
    // committed to ready-ing the multiplexer.)

    self._results = newResults; // Once the ObserveMultiplexer has processed everything we've done in this
    // round, mark all the writes which existed before this call as
    // commmitted. (If new writes have shown up in the meantime, there'll
    // already be another _pollMongo task scheduled.)

    self._multiplexer.onFlush(function () {
      _.each(writesForCycle, function (w) {
        w.committed();
      });
    });
  },
  stop: function () {
    var self = this;
    self._stopped = true;

    _.each(self._stopCallbacks, function (c) {
      c();
    }); // Release any write fences that are waiting on us.


    _.each(self._pendingWrites, function (w) {
      w.committed();
    });

    Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-drivers-polling", -1);
  }
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"oplog_observe_driver.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/oplog_observe_driver.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var Future = Npm.require('fibers/future');

var PHASE = {
  QUERYING: "QUERYING",
  FETCHING: "FETCHING",
  STEADY: "STEADY"
}; // Exception thrown by _needToPollQuery which unrolls the stack up to the
// enclosing call to finishIfNeedToPollQuery.

var SwitchedToQuery = function () {};

var finishIfNeedToPollQuery = function (f) {
  return function () {
    try {
      f.apply(this, arguments);
    } catch (e) {
      if (!(e instanceof SwitchedToQuery)) throw e;
    }
  };
};

var currentId = 0; // OplogObserveDriver is an alternative to PollingObserveDriver which follows
// the Mongo operation log instead of just re-polling the query. It obeys the
// same simple interface: constructing it starts sending observeChanges
// callbacks (and a ready() invocation) to the ObserveMultiplexer, and you stop
// it by calling the stop() method.

OplogObserveDriver = function (options) {
  var self = this;
  self._usesOplog = true; // tests look at this

  self._id = currentId;
  currentId++;
  self._cursorDescription = options.cursorDescription;
  self._mongoHandle = options.mongoHandle;
  self._multiplexer = options.multiplexer;

  if (options.ordered) {
    throw Error("OplogObserveDriver only supports unordered observeChanges");
  }

  var sorter = options.sorter; // We don't support $near and other geo-queries so it's OK to initialize the
  // comparator only once in the constructor.

  var comparator = sorter && sorter.getComparator();

  if (options.cursorDescription.options.limit) {
    // There are several properties ordered driver implements:
    // - _limit is a positive number
    // - _comparator is a function-comparator by which the query is ordered
    // - _unpublishedBuffer is non-null Min/Max Heap,
    //                      the empty buffer in STEADY phase implies that the
    //                      everything that matches the queries selector fits
    //                      into published set.
    // - _published - Min Heap (also implements IdMap methods)
    var heapOptions = {
      IdMap: LocalCollection._IdMap
    };
    self._limit = self._cursorDescription.options.limit;
    self._comparator = comparator;
    self._sorter = sorter;
    self._unpublishedBuffer = new MinMaxHeap(comparator, heapOptions); // We need something that can find Max value in addition to IdMap interface

    self._published = new MaxHeap(comparator, heapOptions);
  } else {
    self._limit = 0;
    self._comparator = null;
    self._sorter = null;
    self._unpublishedBuffer = null;
    self._published = new LocalCollection._IdMap();
  } // Indicates if it is safe to insert a new document at the end of the buffer
  // for this query. i.e. it is known that there are no documents matching the
  // selector those are not in published or buffer.


  self._safeAppendToBuffer = false;
  self._stopped = false;
  self._stopHandles = [];
  Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-drivers-oplog", 1);

  self._registerPhaseChange(PHASE.QUERYING);

  self._matcher = options.matcher;
  var projection = self._cursorDescription.options.fields || {};
  self._projectionFn = LocalCollection._compileProjection(projection); // Projection function, result of combining important fields for selector and
  // existing fields projection

  self._sharedProjection = self._matcher.combineIntoProjection(projection);
  if (sorter) self._sharedProjection = sorter.combineIntoProjection(self._sharedProjection);
  self._sharedProjectionFn = LocalCollection._compileProjection(self._sharedProjection);
  self._needToFetch = new LocalCollection._IdMap();
  self._currentlyFetching = null;
  self._fetchGeneration = 0;
  self._requeryWhenDoneThisQuery = false;
  self._writesToCommitWhenWeReachSteady = []; // If the oplog handle tells us that it skipped some entries (because it got
  // behind, say), re-poll.

  self._stopHandles.push(self._mongoHandle._oplogHandle.onSkippedEntries(finishIfNeedToPollQuery(function () {
    self._needToPollQuery();
  })));

  forEachTrigger(self._cursorDescription, function (trigger) {
    self._stopHandles.push(self._mongoHandle._oplogHandle.onOplogEntry(trigger, function (notification) {
      Meteor._noYieldsAllowed(finishIfNeedToPollQuery(function () {
        var op = notification.op;

        if (notification.dropCollection || notification.dropDatabase) {
          // Note: this call is not allowed to block on anything (especially
          // on waiting for oplog entries to catch up) because that will block
          // onOplogEntry!
          self._needToPollQuery();
        } else {
          // All other operators should be handled depending on phase
          if (self._phase === PHASE.QUERYING) {
            self._handleOplogEntryQuerying(op);
          } else {
            self._handleOplogEntrySteadyOrFetching(op);
          }
        }
      }));
    }));
  }); // XXX ordering w.r.t. everything else?

  self._stopHandles.push(listenAll(self._cursorDescription, function (notification) {
    // If we're not in a pre-fire write fence, we don't have to do anything.
    var fence = DDPServer._CurrentWriteFence.get();

    if (!fence || fence.fired) return;

    if (fence._oplogObserveDrivers) {
      fence._oplogObserveDrivers[self._id] = self;
      return;
    }

    fence._oplogObserveDrivers = {};
    fence._oplogObserveDrivers[self._id] = self;
    fence.onBeforeFire(function () {
      var drivers = fence._oplogObserveDrivers;
      delete fence._oplogObserveDrivers; // This fence cannot fire until we've caught up to "this point" in the
      // oplog, and all observers made it back to the steady state.

      self._mongoHandle._oplogHandle.waitUntilCaughtUp();

      _.each(drivers, function (driver) {
        if (driver._stopped) return;
        var write = fence.beginWrite();

        if (driver._phase === PHASE.STEADY) {
          // Make sure that all of the callbacks have made it through the
          // multiplexer and been delivered to ObserveHandles before committing
          // writes.
          driver._multiplexer.onFlush(function () {
            write.committed();
          });
        } else {
          driver._writesToCommitWhenWeReachSteady.push(write);
        }
      });
    });
  })); // When Mongo fails over, we need to repoll the query, in case we processed an
  // oplog entry that got rolled back.


  self._stopHandles.push(self._mongoHandle._onFailover(finishIfNeedToPollQuery(function () {
    self._needToPollQuery();
  }))); // Give _observeChanges a chance to add the new ObserveHandle to our
  // multiplexer, so that the added calls get streamed.


  Meteor.defer(finishIfNeedToPollQuery(function () {
    self._runInitialQuery();
  }));
};

_.extend(OplogObserveDriver.prototype, {
  _addPublished: function (id, doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var fields = _.clone(doc);

      delete fields._id;

      self._published.set(id, self._sharedProjectionFn(doc));

      self._multiplexer.added(id, self._projectionFn(fields)); // After adding this document, the published set might be overflowed
      // (exceeding capacity specified by limit). If so, push the maximum
      // element to the buffer, we might want to save it in memory to reduce the
      // amount of Mongo lookups in the future.


      if (self._limit && self._published.size() > self._limit) {
        // XXX in theory the size of published is no more than limit+1
        if (self._published.size() !== self._limit + 1) {
          throw new Error("After adding to published, " + (self._published.size() - self._limit) + " documents are overflowing the set");
        }

        var overflowingDocId = self._published.maxElementId();

        var overflowingDoc = self._published.get(overflowingDocId);

        if (EJSON.equals(overflowingDocId, id)) {
          throw new Error("The document just added is overflowing the published set");
        }

        self._published.remove(overflowingDocId);

        self._multiplexer.removed(overflowingDocId);

        self._addBuffered(overflowingDocId, overflowingDoc);
      }
    });
  },
  _removePublished: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._published.remove(id);

      self._multiplexer.removed(id);

      if (!self._limit || self._published.size() === self._limit) return;
      if (self._published.size() > self._limit) throw Error("self._published got too big"); // OK, we are publishing less than the limit. Maybe we should look in the
      // buffer to find the next element past what we were publishing before.

      if (!self._unpublishedBuffer.empty()) {
        // There's something in the buffer; move the first thing in it to
        // _published.
        var newDocId = self._unpublishedBuffer.minElementId();

        var newDoc = self._unpublishedBuffer.get(newDocId);

        self._removeBuffered(newDocId);

        self._addPublished(newDocId, newDoc);

        return;
      } // There's nothing in the buffer.  This could mean one of a few things.
      // (a) We could be in the middle of re-running the query (specifically, we
      // could be in _publishNewResults). In that case, _unpublishedBuffer is
      // empty because we clear it at the beginning of _publishNewResults. In
      // this case, our caller already knows the entire answer to the query and
      // we don't need to do anything fancy here.  Just return.


      if (self._phase === PHASE.QUERYING) return; // (b) We're pretty confident that the union of _published and
      // _unpublishedBuffer contain all documents that match selector. Because
      // _unpublishedBuffer is empty, that means we're confident that _published
      // contains all documents that match selector. So we have nothing to do.

      if (self._safeAppendToBuffer) return; // (c) Maybe there are other documents out there that should be in our
      // buffer. But in that case, when we emptied _unpublishedBuffer in
      // _removeBuffered, we should have called _needToPollQuery, which will
      // either put something in _unpublishedBuffer or set _safeAppendToBuffer
      // (or both), and it will put us in QUERYING for that whole time. So in
      // fact, we shouldn't be able to get here.

      throw new Error("Buffer inexplicably empty");
    });
  },
  _changePublished: function (id, oldDoc, newDoc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._published.set(id, self._sharedProjectionFn(newDoc));

      var projectedNew = self._projectionFn(newDoc);

      var projectedOld = self._projectionFn(oldDoc);

      var changed = DiffSequence.makeChangedFields(projectedNew, projectedOld);
      if (!_.isEmpty(changed)) self._multiplexer.changed(id, changed);
    });
  },
  _addBuffered: function (id, doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._unpublishedBuffer.set(id, self._sharedProjectionFn(doc)); // If something is overflowing the buffer, we just remove it from cache


      if (self._unpublishedBuffer.size() > self._limit) {
        var maxBufferedId = self._unpublishedBuffer.maxElementId();

        self._unpublishedBuffer.remove(maxBufferedId); // Since something matching is removed from cache (both published set and
        // buffer), set flag to false


        self._safeAppendToBuffer = false;
      }
    });
  },
  // Is called either to remove the doc completely from matching set or to move
  // it to the published set later.
  _removeBuffered: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._unpublishedBuffer.remove(id); // To keep the contract "buffer is never empty in STEADY phase unless the
      // everything matching fits into published" true, we poll everything as
      // soon as we see the buffer becoming empty.


      if (!self._unpublishedBuffer.size() && !self._safeAppendToBuffer) self._needToPollQuery();
    });
  },
  // Called when a document has joined the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _addMatching: function (doc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var id = doc._id;
      if (self._published.has(id)) throw Error("tried to add something already published " + id);
      if (self._limit && self._unpublishedBuffer.has(id)) throw Error("tried to add something already existed in buffer " + id);
      var limit = self._limit;
      var comparator = self._comparator;
      var maxPublished = limit && self._published.size() > 0 ? self._published.get(self._published.maxElementId()) : null;
      var maxBuffered = limit && self._unpublishedBuffer.size() > 0 ? self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()) : null; // The query is unlimited or didn't publish enough documents yet or the
      // new document would fit into published set pushing the maximum element
      // out, then we need to publish the doc.

      var toPublish = !limit || self._published.size() < limit || comparator(doc, maxPublished) < 0; // Otherwise we might need to buffer it (only in case of limited query).
      // Buffering is allowed if the buffer is not filled up yet and all
      // matching docs are either in the published set or in the buffer.

      var canAppendToBuffer = !toPublish && self._safeAppendToBuffer && self._unpublishedBuffer.size() < limit; // Or if it is small enough to be safely inserted to the middle or the
      // beginning of the buffer.

      var canInsertIntoBuffer = !toPublish && maxBuffered && comparator(doc, maxBuffered) <= 0;
      var toBuffer = canAppendToBuffer || canInsertIntoBuffer;

      if (toPublish) {
        self._addPublished(id, doc);
      } else if (toBuffer) {
        self._addBuffered(id, doc);
      } else {
        // dropping it and not saving to the cache
        self._safeAppendToBuffer = false;
      }
    });
  },
  // Called when a document leaves the "Matching" results set.
  // Takes responsibility of keeping _unpublishedBuffer in sync with _published
  // and the effect of limit enforced.
  _removeMatching: function (id) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (!self._published.has(id) && !self._limit) throw Error("tried to remove something matching but not cached " + id);

      if (self._published.has(id)) {
        self._removePublished(id);
      } else if (self._unpublishedBuffer.has(id)) {
        self._removeBuffered(id);
      }
    });
  },
  _handleDoc: function (id, newDoc) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var matchesNow = newDoc && self._matcher.documentMatches(newDoc).result;

      var publishedBefore = self._published.has(id);

      var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

      var cachedBefore = publishedBefore || bufferedBefore;

      if (matchesNow && !cachedBefore) {
        self._addMatching(newDoc);
      } else if (cachedBefore && !matchesNow) {
        self._removeMatching(id);
      } else if (cachedBefore && matchesNow) {
        var oldDoc = self._published.get(id);

        var comparator = self._comparator;

        var minBuffered = self._limit && self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.minElementId());

        var maxBuffered;

        if (publishedBefore) {
          // Unlimited case where the document stays in published once it
          // matches or the case when we don't have enough matching docs to
          // publish or the changed but matching doc will stay in published
          // anyways.
          //
          // XXX: We rely on the emptiness of buffer. Be sure to maintain the
          // fact that buffer can't be empty if there are matching documents not
          // published. Notably, we don't want to schedule repoll and continue
          // relying on this property.
          var staysInPublished = !self._limit || self._unpublishedBuffer.size() === 0 || comparator(newDoc, minBuffered) <= 0;

          if (staysInPublished) {
            self._changePublished(id, oldDoc, newDoc);
          } else {
            // after the change doc doesn't stay in the published, remove it
            self._removePublished(id); // but it can move into buffered now, check it


            maxBuffered = self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId());
            var toBuffer = self._safeAppendToBuffer || maxBuffered && comparator(newDoc, maxBuffered) <= 0;

            if (toBuffer) {
              self._addBuffered(id, newDoc);
            } else {
              // Throw away from both published set and buffer
              self._safeAppendToBuffer = false;
            }
          }
        } else if (bufferedBefore) {
          oldDoc = self._unpublishedBuffer.get(id); // remove the old version manually instead of using _removeBuffered so
          // we don't trigger the querying immediately.  if we end this block
          // with the buffer empty, we will need to trigger the query poll
          // manually too.

          self._unpublishedBuffer.remove(id);

          var maxPublished = self._published.get(self._published.maxElementId());

          maxBuffered = self._unpublishedBuffer.size() && self._unpublishedBuffer.get(self._unpublishedBuffer.maxElementId()); // the buffered doc was updated, it could move to published

          var toPublish = comparator(newDoc, maxPublished) < 0; // or stays in buffer even after the change

          var staysInBuffer = !toPublish && self._safeAppendToBuffer || !toPublish && maxBuffered && comparator(newDoc, maxBuffered) <= 0;

          if (toPublish) {
            self._addPublished(id, newDoc);
          } else if (staysInBuffer) {
            // stays in buffer but changes
            self._unpublishedBuffer.set(id, newDoc);
          } else {
            // Throw away from both published set and buffer
            self._safeAppendToBuffer = false; // Normally this check would have been done in _removeBuffered but
            // we didn't use it, so we need to do it ourself now.

            if (!self._unpublishedBuffer.size()) {
              self._needToPollQuery();
            }
          }
        } else {
          throw new Error("cachedBefore implies either of publishedBefore or bufferedBefore is true.");
        }
      }
    });
  },
  _fetchModifiedDocuments: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.FETCHING); // Defer, because nothing called from the oplog entry handler may yield,
      // but fetch() yields.


      Meteor.defer(finishIfNeedToPollQuery(function () {
        while (!self._stopped && !self._needToFetch.empty()) {
          if (self._phase === PHASE.QUERYING) {
            // While fetching, we decided to go into QUERYING mode, and then we
            // saw another oplog entry, so _needToFetch is not empty. But we
            // shouldn't fetch these documents until AFTER the query is done.
            break;
          } // Being in steady phase here would be surprising.


          if (self._phase !== PHASE.FETCHING) throw new Error("phase in fetchModifiedDocuments: " + self._phase);
          self._currentlyFetching = self._needToFetch;
          var thisGeneration = ++self._fetchGeneration;
          self._needToFetch = new LocalCollection._IdMap();
          var waiting = 0;
          var fut = new Future(); // This loop is safe, because _currentlyFetching will not be updated
          // during this loop (in fact, it is never mutated).

          self._currentlyFetching.forEach(function (cacheKey, id) {
            waiting++;

            self._mongoHandle._docFetcher.fetch(self._cursorDescription.collectionName, id, cacheKey, finishIfNeedToPollQuery(function (err, doc) {
              try {
                if (err) {
                  Meteor._debug("Got exception while fetching documents: " + err); // If we get an error from the fetcher (eg, trouble
                  // connecting to Mongo), let's just abandon the fetch phase
                  // altogether and fall back to polling. It's not like we're
                  // getting live updates anyway.


                  if (self._phase !== PHASE.QUERYING) {
                    self._needToPollQuery();
                  }
                } else if (!self._stopped && self._phase === PHASE.FETCHING && self._fetchGeneration === thisGeneration) {
                  // We re-check the generation in case we've had an explicit
                  // _pollQuery call (eg, in another fiber) which should
                  // effectively cancel this round of fetches.  (_pollQuery
                  // increments the generation.)
                  self._handleDoc(id, doc);
                }
              } finally {
                waiting--; // Because fetch() never calls its callback synchronously,
                // this is safe (ie, we won't call fut.return() before the
                // forEach is done).

                if (waiting === 0) fut.return();
              }
            }));
          });

          fut.wait(); // Exit now if we've had a _pollQuery call (here or in another fiber).

          if (self._phase === PHASE.QUERYING) return;
          self._currentlyFetching = null;
        } // We're done fetching, so we can be steady, unless we've had a
        // _pollQuery call (here or in another fiber).


        if (self._phase !== PHASE.QUERYING) self._beSteady();
      }));
    });
  },
  _beSteady: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._registerPhaseChange(PHASE.STEADY);

      var writes = self._writesToCommitWhenWeReachSteady;
      self._writesToCommitWhenWeReachSteady = [];

      self._multiplexer.onFlush(function () {
        _.each(writes, function (w) {
          w.committed();
        });
      });
    });
  },
  _handleOplogEntryQuerying: function (op) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      self._needToFetch.set(idForOp(op), op.ts.toString());
    });
  },
  _handleOplogEntrySteadyOrFetching: function (op) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var id = idForOp(op); // If we're already fetching this one, or about to, we can't optimize;
      // make sure that we fetch it again if necessary.

      if (self._phase === PHASE.FETCHING && (self._currentlyFetching && self._currentlyFetching.has(id) || self._needToFetch.has(id))) {
        self._needToFetch.set(id, op.ts.toString());

        return;
      }

      if (op.op === 'd') {
        if (self._published.has(id) || self._limit && self._unpublishedBuffer.has(id)) self._removeMatching(id);
      } else if (op.op === 'i') {
        if (self._published.has(id)) throw new Error("insert found for already-existing ID in published");
        if (self._unpublishedBuffer && self._unpublishedBuffer.has(id)) throw new Error("insert found for already-existing ID in buffer"); // XXX what if selector yields?  for now it can't but later it could
        // have $where

        if (self._matcher.documentMatches(op.o).result) self._addMatching(op.o);
      } else if (op.op === 'u') {
        // Is this a modifier ($set/$unset, which may require us to poll the
        // database to figure out if the whole document matches the selector) or
        // a replacement (in which case we can just directly re-evaluate the
        // selector)?
        var isReplace = !_.has(op.o, '$set') && !_.has(op.o, '$unset'); // If this modifier modifies something inside an EJSON custom type (ie,
        // anything with EJSON$), then we can't try to use
        // LocalCollection._modify, since that just mutates the EJSON encoding,
        // not the actual object.

        var canDirectlyModifyDoc = !isReplace && modifierCanBeDirectlyApplied(op.o);

        var publishedBefore = self._published.has(id);

        var bufferedBefore = self._limit && self._unpublishedBuffer.has(id);

        if (isReplace) {
          self._handleDoc(id, _.extend({
            _id: id
          }, op.o));
        } else if ((publishedBefore || bufferedBefore) && canDirectlyModifyDoc) {
          // Oh great, we actually know what the document is, so we can apply
          // this directly.
          var newDoc = self._published.has(id) ? self._published.get(id) : self._unpublishedBuffer.get(id);
          newDoc = EJSON.clone(newDoc);
          newDoc._id = id;

          try {
            LocalCollection._modify(newDoc, op.o);
          } catch (e) {
            if (e.name !== "MinimongoError") throw e; // We didn't understand the modifier.  Re-fetch.

            self._needToFetch.set(id, op.ts.toString());

            if (self._phase === PHASE.STEADY) {
              self._fetchModifiedDocuments();
            }

            return;
          }

          self._handleDoc(id, self._sharedProjectionFn(newDoc));
        } else if (!canDirectlyModifyDoc || self._matcher.canBecomeTrueByModifier(op.o) || self._sorter && self._sorter.affectedByModifier(op.o)) {
          self._needToFetch.set(id, op.ts.toString());

          if (self._phase === PHASE.STEADY) self._fetchModifiedDocuments();
        }
      } else {
        throw Error("XXX SURPRISING OPERATION: " + op);
      }
    });
  },
  // Yields!
  _runInitialQuery: function () {
    var self = this;
    if (self._stopped) throw new Error("oplog stopped surprisingly early");

    self._runQuery({
      initial: true
    }); // yields


    if (self._stopped) return; // can happen on queryError
    // Allow observeChanges calls to return. (After this, it's possible for
    // stop() to be called.)

    self._multiplexer.ready();

    self._doneQuerying(); // yields

  },
  // In various circumstances, we may just want to stop processing the oplog and
  // re-run the initial query, just as if we were a PollingObserveDriver.
  //
  // This function may not block, because it is called from an oplog entry
  // handler.
  //
  // XXX We should call this when we detect that we've been in FETCHING for "too
  // long".
  //
  // XXX We should call this when we detect Mongo failover (since that might
  // mean that some of the oplog entries we have processed have been rolled
  // back). The Node Mongo driver is in the middle of a bunch of huge
  // refactorings, including the way that it notifies you when primary
  // changes. Will put off implementing this until driver 1.4 is out.
  _pollQuery: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (self._stopped) return; // Yay, we get to forget about all the things we thought we had to fetch.

      self._needToFetch = new LocalCollection._IdMap();
      self._currentlyFetching = null;
      ++self._fetchGeneration; // ignore any in-flight fetches

      self._registerPhaseChange(PHASE.QUERYING); // Defer so that we don't yield.  We don't need finishIfNeedToPollQuery
      // here because SwitchedToQuery is not thrown in QUERYING mode.


      Meteor.defer(function () {
        self._runQuery();

        self._doneQuerying();
      });
    });
  },
  // Yields!
  _runQuery: function (options) {
    var self = this;
    options = options || {};
    var newResults, newBuffer; // This while loop is just to retry failures.

    while (true) {
      // If we've been stopped, we don't have to run anything any more.
      if (self._stopped) return;
      newResults = new LocalCollection._IdMap();
      newBuffer = new LocalCollection._IdMap(); // Query 2x documents as the half excluded from the original query will go
      // into unpublished buffer to reduce additional Mongo lookups in cases
      // when documents are removed from the published set and need a
      // replacement.
      // XXX needs more thought on non-zero skip
      // XXX 2 is a "magic number" meaning there is an extra chunk of docs for
      // buffer if such is needed.

      var cursor = self._cursorForQuery({
        limit: self._limit * 2
      });

      try {
        cursor.forEach(function (doc, i) {
          // yields
          if (!self._limit || i < self._limit) {
            newResults.set(doc._id, doc);
          } else {
            newBuffer.set(doc._id, doc);
          }
        });
        break;
      } catch (e) {
        if (options.initial && typeof e.code === 'number') {
          // This is an error document sent to us by mongod, not a connection
          // error generated by the client. And we've never seen this query work
          // successfully. Probably it's a bad selector or something, so we
          // should NOT retry. Instead, we should halt the observe (which ends
          // up calling `stop` on us).
          self._multiplexer.queryError(e);

          return;
        } // During failover (eg) if we get an exception we should log and retry
        // instead of crashing.


        Meteor._debug("Got exception while polling query: " + e);

        Meteor._sleepForMs(100);
      }
    }

    if (self._stopped) return;

    self._publishNewResults(newResults, newBuffer);
  },
  // Transitions to QUERYING and runs another query, or (if already in QUERYING)
  // ensures that we will query again later.
  //
  // This function may not block, because it is called from an oplog entry
  // handler. However, if we were not already in the QUERYING phase, it throws
  // an exception that is caught by the closest surrounding
  // finishIfNeedToPollQuery call; this ensures that we don't continue running
  // close that was designed for another phase inside PHASE.QUERYING.
  //
  // (It's also necessary whenever logic in this file yields to check that other
  // phases haven't put us into QUERYING mode, though; eg,
  // _fetchModifiedDocuments does this.)
  _needToPollQuery: function () {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      if (self._stopped) return; // If we're not already in the middle of a query, we can query now
      // (possibly pausing FETCHING).

      if (self._phase !== PHASE.QUERYING) {
        self._pollQuery();

        throw new SwitchedToQuery();
      } // We're currently in QUERYING. Set a flag to ensure that we run another
      // query when we're done.


      self._requeryWhenDoneThisQuery = true;
    });
  },
  // Yields!
  _doneQuerying: function () {
    var self = this;
    if (self._stopped) return;

    self._mongoHandle._oplogHandle.waitUntilCaughtUp(); // yields


    if (self._stopped) return;
    if (self._phase !== PHASE.QUERYING) throw Error("Phase unexpectedly " + self._phase);

    Meteor._noYieldsAllowed(function () {
      if (self._requeryWhenDoneThisQuery) {
        self._requeryWhenDoneThisQuery = false;

        self._pollQuery();
      } else if (self._needToFetch.empty()) {
        self._beSteady();
      } else {
        self._fetchModifiedDocuments();
      }
    });
  },
  _cursorForQuery: function (optionsOverwrite) {
    var self = this;
    return Meteor._noYieldsAllowed(function () {
      // The query we run is almost the same as the cursor we are observing,
      // with a few changes. We need to read all the fields that are relevant to
      // the selector, not just the fields we are going to publish (that's the
      // "shared" projection). And we don't want to apply any transform in the
      // cursor, because observeChanges shouldn't use the transform.
      var options = _.clone(self._cursorDescription.options); // Allow the caller to modify the options. Useful to specify different
      // skip and limit values.


      _.extend(options, optionsOverwrite);

      options.fields = self._sharedProjection;
      delete options.transform; // We are NOT deep cloning fields or selector here, which should be OK.

      var description = new CursorDescription(self._cursorDescription.collectionName, self._cursorDescription.selector, options);
      return new Cursor(self._mongoHandle, description);
    });
  },
  // Replace self._published with newResults (both are IdMaps), invoking observe
  // callbacks on the multiplexer.
  // Replace self._unpublishedBuffer with newBuffer.
  //
  // XXX This is very similar to LocalCollection._diffQueryUnorderedChanges. We
  // should really: (a) Unify IdMap and OrderedDict into Unordered/OrderedDict
  // (b) Rewrite diff.js to use these classes instead of arrays and objects.
  _publishNewResults: function (newResults, newBuffer) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      // If the query is limited and there is a buffer, shut down so it doesn't
      // stay in a way.
      if (self._limit) {
        self._unpublishedBuffer.clear();
      } // First remove anything that's gone. Be careful not to modify
      // self._published while iterating over it.


      var idsToRemove = [];

      self._published.forEach(function (doc, id) {
        if (!newResults.has(id)) idsToRemove.push(id);
      });

      _.each(idsToRemove, function (id) {
        self._removePublished(id);
      }); // Now do adds and changes.
      // If self has a buffer and limit, the new fetched result will be
      // limited correctly as the query has sort specifier.


      newResults.forEach(function (doc, id) {
        self._handleDoc(id, doc);
      }); // Sanity-check that everything we tried to put into _published ended up
      // there.
      // XXX if this is slow, remove it later

      if (self._published.size() !== newResults.size()) {
        throw Error("The Mongo server and the Meteor query disagree on how " + "many documents match your query. Maybe it is hitting a Mongo " + "edge case? The query is: " + EJSON.stringify(self._cursorDescription.selector));
      }

      self._published.forEach(function (doc, id) {
        if (!newResults.has(id)) throw Error("_published has a doc that newResults doesn't; " + id);
      }); // Finally, replace the buffer


      newBuffer.forEach(function (doc, id) {
        self._addBuffered(id, doc);
      });
      self._safeAppendToBuffer = newBuffer.size() < self._limit;
    });
  },
  // This stop function is invoked from the onStop of the ObserveMultiplexer, so
  // it shouldn't actually be possible to call it until the multiplexer is
  // ready.
  //
  // It's important to check self._stopped after every call in this file that
  // can yield!
  stop: function () {
    var self = this;
    if (self._stopped) return;
    self._stopped = true;

    _.each(self._stopHandles, function (handle) {
      handle.stop();
    }); // Note: we *don't* use multiplexer.onFlush here because this stop
    // callback is actually invoked by the multiplexer itself when it has
    // determined that there are no handles left. So nothing is actually going
    // to get flushed (and it's probably not valid to call methods on the
    // dying multiplexer).


    _.each(self._writesToCommitWhenWeReachSteady, function (w) {
      w.committed(); // maybe yields?
    });

    self._writesToCommitWhenWeReachSteady = null; // Proactively drop references to potentially big things.

    self._published = null;
    self._unpublishedBuffer = null;
    self._needToFetch = null;
    self._currentlyFetching = null;
    self._oplogEntryHandle = null;
    self._listenersHandle = null;
    Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "observe-drivers-oplog", -1);
  },
  _registerPhaseChange: function (phase) {
    var self = this;

    Meteor._noYieldsAllowed(function () {
      var now = new Date();

      if (self._phase) {
        var timeDiff = now - self._phaseStartTime;
        Package.facts && Package.facts.Facts.incrementServerFact("mongo-livedata", "time-spent-in-" + self._phase + "-phase", timeDiff);
      }

      self._phase = phase;
      self._phaseStartTime = now;
    });
  }
}); // Does our oplog tailing code support this cursor? For now, we are being very
// conservative and allowing only simple queries with simple options.
// (This is a "static method".)


OplogObserveDriver.cursorSupported = function (cursorDescription, matcher) {
  // First, check the options.
  var options = cursorDescription.options; // Did the user say no explicitly?
  // underscored version of the option is COMPAT with 1.2

  if (options.disableOplog || options._disableOplog) return false; // skip is not supported: to support it we would need to keep track of all
  // "skipped" documents or at least their ids.
  // limit w/o a sort specifier is not supported: current implementation needs a
  // deterministic way to order documents.

  if (options.skip || options.limit && !options.sort) return false; // If a fields projection option is given check if it is supported by
  // minimongo (some operators are not supported).

  if (options.fields) {
    try {
      LocalCollection._checkSupportedProjection(options.fields);
    } catch (e) {
      if (e.name === "MinimongoError") {
        return false;
      } else {
        throw e;
      }
    }
  } // We don't allow the following selectors:
  //   - $where (not confident that we provide the same JS environment
  //             as Mongo, and can yield!)
  //   - $near (has "interesting" properties in MongoDB, like the possibility
  //            of returning an ID multiple times, though even polling maybe
  //            have a bug there)
  //           XXX: once we support it, we would need to think more on how we
  //           initialize the comparators when we create the driver.


  return !matcher.hasWhere() && !matcher.hasGeoQuery();
};

var modifierCanBeDirectlyApplied = function (modifier) {
  return _.all(modifier, function (fields, operation) {
    return _.all(fields, function (value, field) {
      return !/EJSON\$/.test(field);
    });
  });
};

MongoInternals.OplogObserveDriver = OplogObserveDriver;
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"local_collection_driver.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/local_collection_driver.js                                                                           //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  LocalCollectionDriver: () => LocalCollectionDriver
});
const LocalCollectionDriver = new class LocalCollectionDriver {
  constructor() {
    this.noConnCollections = Object.create(null);
  }

  open(name, conn) {
    if (!name) {
      return new LocalCollection();
    }

    if (!conn) {
      return ensureCollection(name, this.noConnCollections);
    }

    if (!conn._mongo_livedata_collections) {
      conn._mongo_livedata_collections = Object.create(null);
    } // XXX is there a way to keep track of a connection's collections without
    // dangling it off the connection object?


    return ensureCollection(name, conn._mongo_livedata_collections);
  }

}();

function ensureCollection(name, collections) {
  return name in collections ? collections[name] : collections[name] = new LocalCollection(name);
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"remote_collection_driver.js":function(require){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/remote_collection_driver.js                                                                          //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
MongoInternals.RemoteCollectionDriver = function (mongo_url, options) {
  var self = this;
  self.mongo = new MongoConnection(mongo_url, options);
};

_.extend(MongoInternals.RemoteCollectionDriver.prototype, {
  open: function (name) {
    var self = this;
    var ret = {};

    _.each(['find', 'findOne', 'insert', 'update', 'upsert', 'remove', '_ensureIndex', '_dropIndex', '_createCappedCollection', 'dropCollection', 'rawCollection'], function (m) {
      ret[m] = _.bind(self.mongo[m], self.mongo, name);
    });

    return ret;
  }
}); // Create the singleton RemoteCollectionDriver only on demand, so we
// only require Mongo configuration if it's actually used (eg, not if
// you're only trying to receive data from a remote DDP server.)


MongoInternals.defaultRemoteCollectionDriver = _.once(function () {
  var connectionOptions = {};
  var mongoUrl = process.env.MONGO_URL;

  if (process.env.MONGO_OPLOG_URL) {
    connectionOptions.oplogUrl = process.env.MONGO_OPLOG_URL;
  }

  if (!mongoUrl) throw new Error("MONGO_URL must be set in environment");
  return new MongoInternals.RemoteCollectionDriver(mongoUrl, connectionOptions);
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"collection.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/collection.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var _extends = require("@babel/runtime/helpers/builtin/extends");

// options.connection, if given, is a LivedataClient or LivedataServer
// XXX presently there is no way to destroy/clean up a Collection

/**
 * @summary Namespace for MongoDB-related items
 * @namespace
 */
Mongo = {};
/**
 * @summary Constructor for a Collection
 * @locus Anywhere
 * @instancename collection
 * @class
 * @param {String} name The name of the collection.  If null, creates an unmanaged (unsynchronized) local collection.
 * @param {Object} [options]
 * @param {Object} options.connection The server connection that will manage this collection. Uses the default connection if not specified.  Pass the return value of calling [`DDP.connect`](#ddp_connect) to specify a different server. Pass `null` to specify no connection. Unmanaged (`name` is null) collections cannot specify a connection.
 * @param {String} options.idGeneration The method of generating the `_id` fields of new documents in this collection.  Possible values:

 - **`'STRING'`**: random strings
 - **`'MONGO'`**:  random [`Mongo.ObjectID`](#mongo_object_id) values

The default id generation technique is `'STRING'`.
 * @param {Function} options.transform An optional transformation function. Documents will be passed through this function before being returned from `fetch` or `findOne`, and before being passed to callbacks of `observe`, `map`, `forEach`, `allow`, and `deny`. Transforms are *not* applied for the callbacks of `observeChanges` or to cursors returned from publish functions.
 * @param {Boolean} options.defineMutationMethods Set to `false` to skip setting up the mutation methods that enable insert/update/remove from client code. Default `true`.
 */

Mongo.Collection = function Collection(name, options) {
  if (!name && name !== null) {
    Meteor._debug("Warning: creating anonymous collection. It will not be " + "saved or synchronized over the network. (Pass null for " + "the collection name to turn off this warning.)");

    name = null;
  }

  if (name !== null && typeof name !== "string") {
    throw new Error("First argument to new Mongo.Collection must be a string or null");
  }

  if (options && options.methods) {
    // Backwards compatibility hack with original signature (which passed
    // "connection" directly instead of in options. (Connections must have a "methods"
    // method.)
    // XXX remove before 1.0
    options = {
      connection: options
    };
  } // Backwards compatibility: "connection" used to be called "manager".


  if (options && options.manager && !options.connection) {
    options.connection = options.manager;
  }

  options = _extends({
    connection: undefined,
    idGeneration: 'STRING',
    transform: null,
    _driver: undefined,
    _preventAutopublish: false
  }, options);

  switch (options.idGeneration) {
    case 'MONGO':
      this._makeNewID = function () {
        var src = name ? DDP.randomStream('/collection/' + name) : Random.insecure;
        return new Mongo.ObjectID(src.hexString(24));
      };

      break;

    case 'STRING':
    default:
      this._makeNewID = function () {
        var src = name ? DDP.randomStream('/collection/' + name) : Random.insecure;
        return src.id();
      };

      break;
  }

  this._transform = LocalCollection.wrapTransform(options.transform);
  if (!name || options.connection === null) // note: nameless collections never have a connection
    this._connection = null;else if (options.connection) this._connection = options.connection;else if (Meteor.isClient) this._connection = Meteor.connection;else this._connection = Meteor.server;

  if (!options._driver) {
    // XXX This check assumes that webapp is loaded so that Meteor.server !==
    // null. We should fully support the case of "want to use a Mongo-backed
    // collection from Node code without webapp", but we don't yet.
    // #MeteorServerNull
    if (name && this._connection === Meteor.server && typeof MongoInternals !== "undefined" && MongoInternals.defaultRemoteCollectionDriver) {
      options._driver = MongoInternals.defaultRemoteCollectionDriver();
    } else {
      const {
        LocalCollectionDriver
      } = require("./local_collection_driver.js");

      options._driver = LocalCollectionDriver;
    }
  }

  this._collection = options._driver.open(name, this._connection);
  this._name = name;
  this._driver = options._driver;

  this._maybeSetUpReplication(name, options); // XXX don't define these until allow or deny is actually used for this
  // collection. Could be hard if the security rules are only defined on the
  // server.


  if (options.defineMutationMethods !== false) {
    try {
      this._defineMutationMethods({
        useExisting: options._suppressSameNameError === true
      });
    } catch (error) {
      // Throw a more understandable error on the server for same collection name
      if (error.message === `A method named '/${name}/insert' is already defined`) throw new Error(`There is already a collection named "${name}"`);
      throw error;
    }
  } // autopublish


  if (Package.autopublish && !options._preventAutopublish && this._connection && this._connection.publish) {
    this._connection.publish(null, () => this.find(), {
      is_auto: true
    });
  }
};

Object.assign(Mongo.Collection.prototype, {
  _maybeSetUpReplication(name, {
    _suppressSameNameError = false
  }) {
    const self = this;

    if (!(self._connection && self._connection.registerStore)) {
      return;
    } // OK, we're going to be a slave, replicating some remote
    // database, except possibly with some temporary divergence while
    // we have unacknowledged RPC's.


    const ok = self._connection.registerStore(name, {
      // Called at the beginning of a batch of updates. batchSize is the number
      // of update calls to expect.
      //
      // XXX This interface is pretty janky. reset probably ought to go back to
      // being its own function, and callers shouldn't have to calculate
      // batchSize. The optimization of not calling pause/remove should be
      // delayed until later: the first call to update() should buffer its
      // message, and then we can either directly apply it at endUpdate time if
      // it was the only update, or do pauseObservers/apply/apply at the next
      // update() if there's another one.
      beginUpdate(batchSize, reset) {
        // pause observers so users don't see flicker when updating several
        // objects at once (including the post-reconnect reset-and-reapply
        // stage), and so that a re-sorting of a query can take advantage of the
        // full _diffQuery moved calculation instead of applying change one at a
        // time.
        if (batchSize > 1 || reset) self._collection.pauseObservers();
        if (reset) self._collection.remove({});
      },

      // Apply an update.
      // XXX better specify this interface (not in terms of a wire message)?
      update(msg) {
        var mongoId = MongoID.idParse(msg.id);

        var doc = self._collection.findOne(mongoId); // Is this a "replace the whole doc" message coming from the quiescence
        // of method writes to an object? (Note that 'undefined' is a valid
        // value meaning "remove it".)


        if (msg.msg === 'replace') {
          var replace = msg.replace;

          if (!replace) {
            if (doc) self._collection.remove(mongoId);
          } else if (!doc) {
            self._collection.insert(replace);
          } else {
            // XXX check that replace has no $ ops
            self._collection.update(mongoId, replace);
          }

          return;
        } else if (msg.msg === 'added') {
          if (doc) {
            throw new Error("Expected not to find a document already present for an add");
          }

          self._collection.insert(_extends({
            _id: mongoId
          }, msg.fields));
        } else if (msg.msg === 'removed') {
          if (!doc) throw new Error("Expected to find a document already present for removed");

          self._collection.remove(mongoId);
        } else if (msg.msg === 'changed') {
          if (!doc) throw new Error("Expected to find a document to change");
          const keys = Object.keys(msg.fields);

          if (keys.length > 0) {
            var modifier = {};
            keys.forEach(key => {
              const value = msg.fields[key];

              if (typeof value === "undefined") {
                if (!modifier.$unset) {
                  modifier.$unset = {};
                }

                modifier.$unset[key] = 1;
              } else {
                if (!modifier.$set) {
                  modifier.$set = {};
                }

                modifier.$set[key] = value;
              }
            });

            self._collection.update(mongoId, modifier);
          }
        } else {
          throw new Error("I don't know how to deal with this message");
        }
      },

      // Called at the end of a batch of updates.
      endUpdate() {
        self._collection.resumeObservers();
      },

      // Called around method stub invocations to capture the original versions
      // of modified documents.
      saveOriginals() {
        self._collection.saveOriginals();
      },

      retrieveOriginals() {
        return self._collection.retrieveOriginals();
      },

      // Used to preserve current versions of documents across a store reset.
      getDoc(id) {
        return self.findOne(id);
      },

      // To be able to get back to the collection from the store.
      _getCollection() {
        return self;
      }

    });

    if (!ok) {
      const message = `There is already a collection named "${name}"`;

      if (_suppressSameNameError === true) {
        // XXX In theory we do not have to throw when `ok` is falsy. The
        // store is already defined for this collection name, but this
        // will simply be another reference to it and everything should
        // work. However, we have historically thrown an error here, so
        // for now we will skip the error only when _suppressSameNameError
        // is `true`, allowing people to opt in and give this some real
        // world testing.
        console.warn ? console.warn(message) : console.log(message);
      } else {
        throw new Error(message);
      }
    }
  },

  ///
  /// Main collection API
  ///
  _getFindSelector(args) {
    if (args.length == 0) return {};else return args[0];
  },

  _getFindOptions(args) {
    var self = this;

    if (args.length < 2) {
      return {
        transform: self._transform
      };
    } else {
      check(args[1], Match.Optional(Match.ObjectIncluding({
        fields: Match.Optional(Match.OneOf(Object, undefined)),
        sort: Match.Optional(Match.OneOf(Object, Array, Function, undefined)),
        limit: Match.Optional(Match.OneOf(Number, undefined)),
        skip: Match.Optional(Match.OneOf(Number, undefined))
      })));
      return _extends({
        transform: self._transform
      }, args[1]);
    }
  },

  /**
   * @summary Find the documents in a collection that match the selector.
   * @locus Anywhere
   * @method find
   * @memberOf Mongo.Collection
   * @instance
   * @param {MongoSelector} [selector] A query describing the documents to find
   * @param {Object} [options]
   * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)
   * @param {Number} options.skip Number of results to skip at the beginning
   * @param {Number} options.limit Maximum number of results to return
   * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.
   * @param {Boolean} options.reactive (Client only) Default `true`; pass `false` to disable reactivity
   * @param {Function} options.transform Overrides `transform` on the  [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
   * @param {Boolean} options.disableOplog (Server only) Pass true to disable oplog-tailing on this query. This affects the way server processes calls to `observe` on this query. Disabling the oplog can be useful when working with data that updates in large batches.
   * @param {Number} options.pollingIntervalMs (Server only) When oplog is disabled (through the use of `disableOplog` or when otherwise not available), the frequency (in milliseconds) of how often to poll this query when observing on the server. Defaults to 10000ms (10 seconds).
   * @param {Number} options.pollingThrottleMs (Server only) When oplog is disabled (through the use of `disableOplog` or when otherwise not available), the minimum time (in milliseconds) to allow between re-polling when observing on the server. Increasing this will save CPU and mongo load at the expense of slower updates to users. Decreasing this is not recommended. Defaults to 50ms.
   * @param {Number} options.maxTimeMs (Server only) If set, instructs MongoDB to set a time limit for this cursor's operations. If the operation reaches the specified time limit (in milliseconds) without the having been completed, an exception will be thrown. Useful to prevent an (accidental or malicious) unoptimized query from causing a full collection scan that would disrupt other database users, at the expense of needing to handle the resulting error.
   * @param {String|Object} options.hint (Server only) Overrides MongoDB's default index selection and query optimization process. Specify an index to force its use, either by its name or index specification. You can also specify `{ $natural : 1 }` to force a forwards collection scan, or `{ $natural : -1 }` for a reverse collection scan. Setting this is only recommended for advanced users.
   * @returns {Mongo.Cursor}
   */
  find(...args) {
    // Collection.find() (return all docs) behaves differently
    // from Collection.find(undefined) (return 0 docs).  so be
    // careful about the length of arguments.
    return this._collection.find(this._getFindSelector(args), this._getFindOptions(args));
  },

  /**
   * @summary Finds the first document that matches the selector, as ordered by sort and skip options. Returns `undefined` if no matching document is found.
   * @locus Anywhere
   * @method findOne
   * @memberOf Mongo.Collection
   * @instance
   * @param {MongoSelector} [selector] A query describing the documents to find
   * @param {Object} [options]
   * @param {MongoSortSpecifier} options.sort Sort order (default: natural order)
   * @param {Number} options.skip Number of results to skip at the beginning
   * @param {MongoFieldSpecifier} options.fields Dictionary of fields to return or exclude.
   * @param {Boolean} options.reactive (Client only) Default true; pass false to disable reactivity
   * @param {Function} options.transform Overrides `transform` on the [`Collection`](#collections) for this cursor.  Pass `null` to disable transformation.
   * @returns {Object}
   */
  findOne(...args) {
    return this._collection.findOne(this._getFindSelector(args), this._getFindOptions(args));
  }

});
Object.assign(Mongo.Collection, {
  _publishCursor(cursor, sub, collection) {
    var observeHandle = cursor.observeChanges({
      added: function (id, fields) {
        sub.added(collection, id, fields);
      },
      changed: function (id, fields) {
        sub.changed(collection, id, fields);
      },
      removed: function (id) {
        sub.removed(collection, id);
      }
    }); // We don't call sub.ready() here: it gets called in livedata_server, after
    // possibly calling _publishCursor on multiple returned cursors.
    // register stop callback (expects lambda w/ no args).

    sub.onStop(function () {
      observeHandle.stop();
    }); // return the observeHandle in case it needs to be stopped early

    return observeHandle;
  },

  // protect against dangerous selectors.  falsey and {_id: falsey} are both
  // likely programmer error, and not what you want, particularly for destructive
  // operations. If a falsey _id is sent in, a new string _id will be
  // generated and returned; if a fallbackId is provided, it will be returned
  // instead.
  _rewriteSelector(selector, {
    fallbackId
  } = {}) {
    // shorthand -- scalars match _id
    if (LocalCollection._selectorIsId(selector)) selector = {
      _id: selector
    };

    if (Array.isArray(selector)) {
      // This is consistent with the Mongo console itself; if we don't do this
      // check passing an empty array ends up selecting all items
      throw new Error("Mongo selector can't be an array.");
    }

    if (!selector || '_id' in selector && !selector._id) {
      // can't match anything
      return {
        _id: fallbackId || Random.id()
      };
    }

    return selector;
  }

});
Object.assign(Mongo.Collection.prototype, {
  // 'insert' immediately returns the inserted document's new _id.
  // The others return values immediately if you are in a stub, an in-memory
  // unmanaged collection, or a mongo-backed collection and you don't pass a
  // callback. 'update' and 'remove' return the number of affected
  // documents. 'upsert' returns an object with keys 'numberAffected' and, if an
  // insert happened, 'insertedId'.
  //
  // Otherwise, the semantics are exactly like other methods: they take
  // a callback as an optional last argument; if no callback is
  // provided, they block until the operation is complete, and throw an
  // exception if it fails; if a callback is provided, then they don't
  // necessarily block, and they call the callback when they finish with error and
  // result arguments.  (The insert method provides the document ID as its result;
  // update and remove provide the number of affected docs as the result; upsert
  // provides an object with numberAffected and maybe insertedId.)
  //
  // On the client, blocking is impossible, so if a callback
  // isn't provided, they just return immediately and any error
  // information is lost.
  //
  // There's one more tweak. On the client, if you don't provide a
  // callback, then if there is an error, a message will be logged with
  // Meteor._debug.
  //
  // The intent (though this is actually determined by the underlying
  // drivers) is that the operations should be done synchronously, not
  // generating their result until the database has acknowledged
  // them. In the future maybe we should provide a flag to turn this
  // off.

  /**
   * @summary Insert a document in the collection.  Returns its unique _id.
   * @locus Anywhere
   * @method  insert
   * @memberOf Mongo.Collection
   * @instance
   * @param {Object} doc The document to insert. May not yet have an _id attribute, in which case Meteor will generate one for you.
   * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the _id as the second.
   */
  insert(doc, callback) {
    // Make sure we were passed a document to insert
    if (!doc) {
      throw new Error("insert requires an argument");
    } // Make a shallow clone of the document, preserving its prototype.


    doc = Object.create(Object.getPrototypeOf(doc), Object.getOwnPropertyDescriptors(doc));

    if ('_id' in doc) {
      if (!doc._id || !(typeof doc._id === 'string' || doc._id instanceof Mongo.ObjectID)) {
        throw new Error("Meteor requires document _id fields to be non-empty strings or ObjectIDs");
      }
    } else {
      let generateId = true; // Don't generate the id if we're the client and the 'outermost' call
      // This optimization saves us passing both the randomSeed and the id
      // Passing both is redundant.

      if (this._isRemoteCollection()) {
        const enclosing = DDP._CurrentMethodInvocation.get();

        if (!enclosing) {
          generateId = false;
        }
      }

      if (generateId) {
        doc._id = this._makeNewID();
      }
    } // On inserts, always return the id that we generated; on all other
    // operations, just return the result from the collection.


    var chooseReturnValueFromCollectionResult = function (result) {
      if (doc._id) {
        return doc._id;
      } // XXX what is this for??
      // It's some iteraction between the callback to _callMutatorMethod and
      // the return value conversion


      doc._id = result;
      return result;
    };

    const wrappedCallback = wrapCallback(callback, chooseReturnValueFromCollectionResult);

    if (this._isRemoteCollection()) {
      const result = this._callMutatorMethod("insert", [doc], wrappedCallback);

      return chooseReturnValueFromCollectionResult(result);
    } // it's my collection.  descend into the collection object
    // and propagate any exception.


    try {
      // If the user provided a callback and the collection implements this
      // operation asynchronously, then queryRet will be undefined, and the
      // result will be returned through the callback instead.
      const result = this._collection.insert(doc, wrappedCallback);

      return chooseReturnValueFromCollectionResult(result);
    } catch (e) {
      if (callback) {
        callback(e);
        return null;
      }

      throw e;
    }
  },

  /**
   * @summary Modify one or more documents in the collection. Returns the number of matched documents.
   * @locus Anywhere
   * @method update
   * @memberOf Mongo.Collection
   * @instance
   * @param {MongoSelector} selector Specifies which documents to modify
   * @param {MongoModifier} modifier Specifies how to modify the documents
   * @param {Object} [options]
   * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
   * @param {Boolean} options.upsert True to insert a document if no matching documents are found.
   * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
   */
  update(selector, modifier, ...optionsAndCallback) {
    const callback = popCallbackFromArgs(optionsAndCallback); // We've already popped off the callback, so we are left with an array
    // of one or zero items

    const options = _extends({}, optionsAndCallback[0] || null);

    let insertedId;

    if (options && options.upsert) {
      // set `insertedId` if absent.  `insertedId` is a Meteor extension.
      if (options.insertedId) {
        if (!(typeof options.insertedId === 'string' || options.insertedId instanceof Mongo.ObjectID)) throw new Error("insertedId must be string or ObjectID");
        insertedId = options.insertedId;
      } else if (!selector || !selector._id) {
        insertedId = this._makeNewID();
        options.generatedId = true;
        options.insertedId = insertedId;
      }
    }

    selector = Mongo.Collection._rewriteSelector(selector, {
      fallbackId: insertedId
    });
    const wrappedCallback = wrapCallback(callback);

    if (this._isRemoteCollection()) {
      const args = [selector, modifier, options];
      return this._callMutatorMethod("update", args, wrappedCallback);
    } // it's my collection.  descend into the collection object
    // and propagate any exception.


    try {
      // If the user provided a callback and the collection implements this
      // operation asynchronously, then queryRet will be undefined, and the
      // result will be returned through the callback instead.
      return this._collection.update(selector, modifier, options, wrappedCallback);
    } catch (e) {
      if (callback) {
        callback(e);
        return null;
      }

      throw e;
    }
  },

  /**
   * @summary Remove documents from the collection
   * @locus Anywhere
   * @method remove
   * @memberOf Mongo.Collection
   * @instance
   * @param {MongoSelector} selector Specifies which documents to remove
   * @param {Function} [callback] Optional.  If present, called with an error object as its argument.
   */
  remove(selector, callback) {
    selector = Mongo.Collection._rewriteSelector(selector);
    const wrappedCallback = wrapCallback(callback);

    if (this._isRemoteCollection()) {
      return this._callMutatorMethod("remove", [selector], wrappedCallback);
    } // it's my collection.  descend into the collection object
    // and propagate any exception.


    try {
      // If the user provided a callback and the collection implements this
      // operation asynchronously, then queryRet will be undefined, and the
      // result will be returned through the callback instead.
      return this._collection.remove(selector, wrappedCallback);
    } catch (e) {
      if (callback) {
        callback(e);
        return null;
      }

      throw e;
    }
  },

  // Determine if this collection is simply a minimongo representation of a real
  // database on another server
  _isRemoteCollection() {
    // XXX see #MeteorServerNull
    return this._connection && this._connection !== Meteor.server;
  },

  /**
   * @summary Modify one or more documents in the collection, or insert one if no matching documents were found. Returns an object with keys `numberAffected` (the number of documents modified)  and `insertedId` (the unique _id of the document that was inserted, if any).
   * @locus Anywhere
   * @param {MongoSelector} selector Specifies which documents to modify
   * @param {MongoModifier} modifier Specifies how to modify the documents
   * @param {Object} [options]
   * @param {Boolean} options.multi True to modify all matching documents; false to only modify one of the matching documents (the default).
   * @param {Function} [callback] Optional.  If present, called with an error object as the first argument and, if no error, the number of affected documents as the second.
   */
  upsert(selector, modifier, options, callback) {
    if (!callback && typeof options === "function") {
      callback = options;
      options = {};
    }

    return this.update(selector, modifier, _extends({}, options, {
      _returnObject: true,
      upsert: true
    }), callback);
  },

  // We'll actually design an index API later. For now, we just pass through to
  // Mongo's, but make it synchronous.
  _ensureIndex(index, options) {
    var self = this;
    if (!self._collection._ensureIndex) throw new Error("Can only call _ensureIndex on server collections");

    self._collection._ensureIndex(index, options);
  },

  _dropIndex(index) {
    var self = this;
    if (!self._collection._dropIndex) throw new Error("Can only call _dropIndex on server collections");

    self._collection._dropIndex(index);
  },

  _dropCollection() {
    var self = this;
    if (!self._collection.dropCollection) throw new Error("Can only call _dropCollection on server collections");

    self._collection.dropCollection();
  },

  _createCappedCollection(byteSize, maxDocuments) {
    var self = this;
    if (!self._collection._createCappedCollection) throw new Error("Can only call _createCappedCollection on server collections");

    self._collection._createCappedCollection(byteSize, maxDocuments);
  },

  /**
   * @summary Returns the [`Collection`](http://mongodb.github.io/node-mongodb-native/2.2/api/Collection.html) object corresponding to this collection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
   * @locus Server
   */
  rawCollection() {
    var self = this;

    if (!self._collection.rawCollection) {
      throw new Error("Can only call rawCollection on server collections");
    }

    return self._collection.rawCollection();
  },

  /**
   * @summary Returns the [`Db`](http://mongodb.github.io/node-mongodb-native/2.2/api/Db.html) object corresponding to this collection's database connection from the [npm `mongodb` driver module](https://www.npmjs.com/package/mongodb) which is wrapped by `Mongo.Collection`.
   * @locus Server
   */
  rawDatabase() {
    var self = this;

    if (!(self._driver.mongo && self._driver.mongo.db)) {
      throw new Error("Can only call rawDatabase on server collections");
    }

    return self._driver.mongo.db;
  }

}); // Convert the callback to not return a result if there is an error

function wrapCallback(callback, convertResult) {
  return callback && function (error, result) {
    if (error) {
      callback(error);
    } else if (typeof convertResult === "function") {
      callback(null, convertResult(result));
    } else {
      callback(null, result);
    }
  };
}
/**
 * @summary Create a Mongo-style `ObjectID`.  If you don't specify a `hexString`, the `ObjectID` will generated randomly (not using MongoDB's ID construction rules).
 * @locus Anywhere
 * @class
 * @param {String} [hexString] Optional.  The 24-character hexadecimal contents of the ObjectID to create
 */


Mongo.ObjectID = MongoID.ObjectID;
/**
 * @summary To create a cursor, use find. To access the documents in a cursor, use forEach, map, or fetch.
 * @class
 * @instanceName cursor
 */

Mongo.Cursor = LocalCollection.Cursor;
/**
 * @deprecated in 0.9.1
 */

Mongo.Collection.Cursor = Mongo.Cursor;
/**
 * @deprecated in 0.9.1
 */

Mongo.Collection.ObjectID = Mongo.ObjectID;
/**
 * @deprecated in 0.9.1
 */

Meteor.Collection = Mongo.Collection; // Allow deny stuff is now in the allow-deny package

Object.assign(Meteor.Collection.prototype, AllowDeny.CollectionPrototype);

function popCallbackFromArgs(args) {
  // Pull off any callback (or perhaps a 'callback' variable that was passed
  // in undefined, like how 'upsert' does it).
  if (args.length && (args[args.length - 1] === undefined || args[args.length - 1] instanceof Function)) {
    return args.pop();
  }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"connection_options.js":function(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/mongo/connection_options.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
/**
 * @summary Allows for user specified connection options
 * @example http://mongodb.github.io/node-mongodb-native/2.2/reference/connecting/connection-settings/
 * @locus Server
 * @param {Object} options User specified Mongo connection options
 */
Mongo.setConnectionOptions = function setConnectionOptions(options) {
  check(options, Object);
  Mongo._connectionOptions = options;
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});
require("/node_modules/meteor/mongo/mongo_driver.js");
require("/node_modules/meteor/mongo/oplog_tailing.js");
require("/node_modules/meteor/mongo/observe_multiplex.js");
require("/node_modules/meteor/mongo/doc_fetcher.js");
require("/node_modules/meteor/mongo/polling_observe_driver.js");
require("/node_modules/meteor/mongo/oplog_observe_driver.js");
require("/node_modules/meteor/mongo/local_collection_driver.js");
require("/node_modules/meteor/mongo/remote_collection_driver.js");
require("/node_modules/meteor/mongo/collection.js");
require("/node_modules/meteor/mongo/connection_options.js");

/* Exports */
Package._define("mongo", {
  MongoInternals: MongoInternals,
  MongoTest: MongoTest,
  Mongo: Mongo
});

})();

//# sourceURL=meteor://💻app/packages/mongo.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vbW9uZ29fZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9vcGxvZ190YWlsaW5nLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9vYnNlcnZlX211bHRpcGxleC5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vZG9jX2ZldGNoZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21vbmdvL3BvbGxpbmdfb2JzZXJ2ZV9kcml2ZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21vbmdvL29wbG9nX29ic2VydmVfZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9sb2NhbF9jb2xsZWN0aW9uX2RyaXZlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbW9uZ28vcmVtb3RlX2NvbGxlY3Rpb25fZHJpdmVyLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9jb2xsZWN0aW9uLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9tb25nby9jb25uZWN0aW9uX29wdGlvbnMuanMiXSwibmFtZXMiOlsiTW9uZ29EQiIsIk5wbU1vZHVsZU1vbmdvZGIiLCJGdXR1cmUiLCJOcG0iLCJyZXF1aXJlIiwiTW9uZ29JbnRlcm5hbHMiLCJNb25nb1Rlc3QiLCJOcG1Nb2R1bGVzIiwibW9uZ29kYiIsInZlcnNpb24iLCJOcG1Nb2R1bGVNb25nb2RiVmVyc2lvbiIsIm1vZHVsZSIsIk5wbU1vZHVsZSIsInJlcGxhY2VOYW1lcyIsImZpbHRlciIsInRoaW5nIiwiXyIsImlzQXJyYXkiLCJtYXAiLCJiaW5kIiwicmV0IiwiZWFjaCIsInZhbHVlIiwia2V5IiwiVGltZXN0YW1wIiwicHJvdG90eXBlIiwiY2xvbmUiLCJtYWtlTW9uZ29MZWdhbCIsIm5hbWUiLCJ1bm1ha2VNb25nb0xlZ2FsIiwic3Vic3RyIiwicmVwbGFjZU1vbmdvQXRvbVdpdGhNZXRlb3IiLCJkb2N1bWVudCIsIkJpbmFyeSIsImJ1ZmZlciIsIlVpbnQ4QXJyYXkiLCJPYmplY3RJRCIsIk1vbmdvIiwidG9IZXhTdHJpbmciLCJzaXplIiwiRUpTT04iLCJmcm9tSlNPTlZhbHVlIiwidW5kZWZpbmVkIiwicmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28iLCJpc0JpbmFyeSIsIkJ1ZmZlciIsImZyb20iLCJfaXNDdXN0b21UeXBlIiwidG9KU09OVmFsdWUiLCJyZXBsYWNlVHlwZXMiLCJhdG9tVHJhbnNmb3JtZXIiLCJyZXBsYWNlZFRvcExldmVsQXRvbSIsInZhbCIsInZhbFJlcGxhY2VkIiwiTW9uZ29Db25uZWN0aW9uIiwidXJsIiwib3B0aW9ucyIsInNlbGYiLCJfb2JzZXJ2ZU11bHRpcGxleGVycyIsIl9vbkZhaWxvdmVySG9vayIsIkhvb2siLCJtb25nb09wdGlvbnMiLCJPYmplY3QiLCJhc3NpZ24iLCJhdXRvUmVjb25uZWN0IiwicmVjb25uZWN0VHJpZXMiLCJJbmZpbml0eSIsImlnbm9yZVVuZGVmaW5lZCIsIl9jb25uZWN0aW9uT3B0aW9ucyIsInRlc3QiLCJuYXRpdmVfcGFyc2VyIiwiaGFzIiwicG9vbFNpemUiLCJkYiIsIl9wcmltYXJ5IiwiX29wbG9nSGFuZGxlIiwiX2RvY0ZldGNoZXIiLCJjb25uZWN0RnV0dXJlIiwiY29ubmVjdCIsIk1ldGVvciIsImJpbmRFbnZpcm9ubWVudCIsImVyciIsInNlcnZlckNvbmZpZyIsImlzTWFzdGVyRG9jIiwicHJpbWFyeSIsIm9uIiwia2luZCIsImRvYyIsImNhbGxiYWNrIiwibWUiLCJyZXNvbHZlciIsIndhaXQiLCJvcGxvZ1VybCIsIlBhY2thZ2UiLCJPcGxvZ0hhbmRsZSIsImRhdGFiYXNlTmFtZSIsIkRvY0ZldGNoZXIiLCJjbG9zZSIsIkVycm9yIiwib3Bsb2dIYW5kbGUiLCJzdG9wIiwid3JhcCIsInJhd0NvbGxlY3Rpb24iLCJjb2xsZWN0aW9uTmFtZSIsImZ1dHVyZSIsImNvbGxlY3Rpb24iLCJfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbiIsImJ5dGVTaXplIiwibWF4RG9jdW1lbnRzIiwiY3JlYXRlQ29sbGVjdGlvbiIsImNhcHBlZCIsIm1heCIsIl9tYXliZUJlZ2luV3JpdGUiLCJmZW5jZSIsIkREUFNlcnZlciIsIl9DdXJyZW50V3JpdGVGZW5jZSIsImdldCIsImJlZ2luV3JpdGUiLCJjb21taXR0ZWQiLCJfb25GYWlsb3ZlciIsInJlZ2lzdGVyIiwid3JpdGVDYWxsYmFjayIsIndyaXRlIiwicmVmcmVzaCIsInJlc3VsdCIsInJlZnJlc2hFcnIiLCJiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSIsIl9pbnNlcnQiLCJjb2xsZWN0aW9uX25hbWUiLCJzZW5kRXJyb3IiLCJlIiwiX2V4cGVjdGVkQnlUZXN0IiwiTG9jYWxDb2xsZWN0aW9uIiwiX2lzUGxhaW5PYmplY3QiLCJpZCIsIl9pZCIsImluc2VydCIsInNhZmUiLCJfcmVmcmVzaCIsInNlbGVjdG9yIiwicmVmcmVzaEtleSIsInNwZWNpZmljSWRzIiwiX2lkc01hdGNoZWRCeVNlbGVjdG9yIiwiZXh0ZW5kIiwiX3JlbW92ZSIsIndyYXBwZWRDYWxsYmFjayIsImRyaXZlclJlc3VsdCIsInRyYW5zZm9ybVJlc3VsdCIsIm51bWJlckFmZmVjdGVkIiwicmVtb3ZlIiwiX2Ryb3BDb2xsZWN0aW9uIiwiY2IiLCJkcm9wQ29sbGVjdGlvbiIsImRyb3AiLCJfZHJvcERhdGFiYXNlIiwiZHJvcERhdGFiYXNlIiwiX3VwZGF0ZSIsIm1vZCIsIkZ1bmN0aW9uIiwibW9uZ29PcHRzIiwidXBzZXJ0IiwibXVsdGkiLCJmdWxsUmVzdWx0IiwibW9uZ29TZWxlY3RvciIsIm1vbmdvTW9kIiwiaXNNb2RpZnkiLCJfaXNNb2RpZmljYXRpb25Nb2QiLCJfZm9yYmlkUmVwbGFjZSIsImtub3duSWQiLCJuZXdEb2MiLCJfY3JlYXRlVXBzZXJ0RG9jdW1lbnQiLCJpbnNlcnRlZElkIiwiZ2VuZXJhdGVkSWQiLCJzaW11bGF0ZVVwc2VydFdpdGhJbnNlcnRlZElkIiwiZXJyb3IiLCJfcmV0dXJuT2JqZWN0IiwiaGFzT3duUHJvcGVydHkiLCIkc2V0T25JbnNlcnQiLCJ1cGRhdGUiLCJtZXRlb3JSZXN1bHQiLCJtb25nb1Jlc3VsdCIsInVwc2VydGVkIiwibGVuZ3RoIiwibiIsIk5VTV9PUFRJTUlTVElDX1RSSUVTIiwiX2lzQ2Fubm90Q2hhbmdlSWRFcnJvciIsImVycm1zZyIsImluZGV4T2YiLCJtb25nb09wdHNGb3JVcGRhdGUiLCJtb25nb09wdHNGb3JJbnNlcnQiLCJyZXBsYWNlbWVudFdpdGhJZCIsInRyaWVzIiwiZG9VcGRhdGUiLCJkb0NvbmRpdGlvbmFsSW5zZXJ0IiwibWV0aG9kIiwid3JhcEFzeW5jIiwiYXBwbHkiLCJhcmd1bWVudHMiLCJmaW5kIiwiQ3Vyc29yIiwiQ3Vyc29yRGVzY3JpcHRpb24iLCJmaW5kT25lIiwibGltaXQiLCJmZXRjaCIsIl9lbnN1cmVJbmRleCIsImluZGV4IiwiaW5kZXhOYW1lIiwiZW5zdXJlSW5kZXgiLCJfZHJvcEluZGV4IiwiZHJvcEluZGV4IiwiQ29sbGVjdGlvbiIsIl9yZXdyaXRlU2VsZWN0b3IiLCJtb25nbyIsImN1cnNvckRlc2NyaXB0aW9uIiwiX21vbmdvIiwiX2N1cnNvckRlc2NyaXB0aW9uIiwiX3N5bmNocm9ub3VzQ3Vyc29yIiwidGFpbGFibGUiLCJfY3JlYXRlU3luY2hyb25vdXNDdXJzb3IiLCJzZWxmRm9ySXRlcmF0aW9uIiwidXNlVHJhbnNmb3JtIiwicmV3aW5kIiwiZ2V0VHJhbnNmb3JtIiwidHJhbnNmb3JtIiwiX3B1Ymxpc2hDdXJzb3IiLCJzdWIiLCJfZ2V0Q29sbGVjdGlvbk5hbWUiLCJvYnNlcnZlIiwiY2FsbGJhY2tzIiwiX29ic2VydmVGcm9tT2JzZXJ2ZUNoYW5nZXMiLCJvYnNlcnZlQ2hhbmdlcyIsIm1ldGhvZHMiLCJvcmRlcmVkIiwiX29ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzQXJlT3JkZXJlZCIsImV4Y2VwdGlvbk5hbWUiLCJmb3JFYWNoIiwiX29ic2VydmVDaGFuZ2VzIiwicGljayIsImN1cnNvck9wdGlvbnMiLCJzb3J0Iiwic2tpcCIsImF3YWl0ZGF0YSIsIm51bWJlck9mUmV0cmllcyIsIk9QTE9HX0NPTExFQ1RJT04iLCJ0cyIsIm9wbG9nUmVwbGF5IiwiZGJDdXJzb3IiLCJmaWVsZHMiLCJtYXhUaW1lTXMiLCJtYXhUaW1lTVMiLCJoaW50IiwiU3luY2hyb25vdXNDdXJzb3IiLCJfZGJDdXJzb3IiLCJfc2VsZkZvckl0ZXJhdGlvbiIsIl90cmFuc2Zvcm0iLCJ3cmFwVHJhbnNmb3JtIiwiX3N5bmNocm9ub3VzTmV4dE9iamVjdCIsIm5leHRPYmplY3QiLCJfc3luY2hyb25vdXNDb3VudCIsImNvdW50IiwiX3Zpc2l0ZWRJZHMiLCJfSWRNYXAiLCJfbmV4dE9iamVjdCIsInNldCIsInRoaXNBcmciLCJfcmV3aW5kIiwiY2FsbCIsInJlcyIsInB1c2giLCJpZGVudGl0eSIsImFwcGx5U2tpcExpbWl0IiwiZ2V0UmF3T2JqZWN0cyIsInJlc3VsdHMiLCJ0YWlsIiwiZG9jQ2FsbGJhY2siLCJjdXJzb3IiLCJzdG9wcGVkIiwibGFzdFRTIiwibG9vcCIsIm5ld1NlbGVjdG9yIiwiJGd0Iiwic2V0VGltZW91dCIsImRlZmVyIiwiX29ic2VydmVDaGFuZ2VzVGFpbGFibGUiLCJvYnNlcnZlS2V5Iiwic3RyaW5naWZ5IiwibXVsdGlwbGV4ZXIiLCJvYnNlcnZlRHJpdmVyIiwiZmlyc3RIYW5kbGUiLCJfbm9ZaWVsZHNBbGxvd2VkIiwiT2JzZXJ2ZU11bHRpcGxleGVyIiwib25TdG9wIiwib2JzZXJ2ZUhhbmRsZSIsIk9ic2VydmVIYW5kbGUiLCJtYXRjaGVyIiwic29ydGVyIiwiY2FuVXNlT3Bsb2ciLCJhbGwiLCJfdGVzdE9ubHlQb2xsQ2FsbGJhY2siLCJNaW5pbW9uZ28iLCJNYXRjaGVyIiwiT3Bsb2dPYnNlcnZlRHJpdmVyIiwiY3Vyc29yU3VwcG9ydGVkIiwiU29ydGVyIiwiZiIsImRyaXZlckNsYXNzIiwiUG9sbGluZ09ic2VydmVEcml2ZXIiLCJtb25nb0hhbmRsZSIsIl9vYnNlcnZlRHJpdmVyIiwiYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzIiwibGlzdGVuQWxsIiwibGlzdGVuQ2FsbGJhY2siLCJsaXN0ZW5lcnMiLCJmb3JFYWNoVHJpZ2dlciIsInRyaWdnZXIiLCJfSW52YWxpZGF0aW9uQ3Jvc3NiYXIiLCJsaXN0ZW4iLCJsaXN0ZW5lciIsInRyaWdnZXJDYWxsYmFjayIsImFkZGVkQmVmb3JlIiwiYWRkZWQiLCJNb25nb1RpbWVzdGFtcCIsIkNvbm5lY3Rpb24iLCJUT09fRkFSX0JFSElORCIsInByb2Nlc3MiLCJlbnYiLCJNRVRFT1JfT1BMT0dfVE9PX0ZBUl9CRUhJTkQiLCJzaG93VFMiLCJnZXRIaWdoQml0cyIsImdldExvd0JpdHMiLCJpZEZvck9wIiwib3AiLCJvIiwibzIiLCJkYk5hbWUiLCJfb3Bsb2dVcmwiLCJfZGJOYW1lIiwiX29wbG9nTGFzdEVudHJ5Q29ubmVjdGlvbiIsIl9vcGxvZ1RhaWxDb25uZWN0aW9uIiwiX3N0b3BwZWQiLCJfdGFpbEhhbmRsZSIsIl9yZWFkeUZ1dHVyZSIsIl9jcm9zc2JhciIsIl9Dcm9zc2JhciIsImZhY3RQYWNrYWdlIiwiZmFjdE5hbWUiLCJfYmFzZU9wbG9nU2VsZWN0b3IiLCJucyIsIlJlZ0V4cCIsIl9lc2NhcGVSZWdFeHAiLCIkb3IiLCIkaW4iLCIkZXhpc3RzIiwiX2NhdGNoaW5nVXBGdXR1cmVzIiwiX2xhc3RQcm9jZXNzZWRUUyIsIl9vblNraXBwZWRFbnRyaWVzSG9vayIsImRlYnVnUHJpbnRFeGNlcHRpb25zIiwiX2VudHJ5UXVldWUiLCJfRG91YmxlRW5kZWRRdWV1ZSIsIl93b3JrZXJBY3RpdmUiLCJfc3RhcnRUYWlsaW5nIiwib25PcGxvZ0VudHJ5Iiwib3JpZ2luYWxDYWxsYmFjayIsIm5vdGlmaWNhdGlvbiIsIl9kZWJ1ZyIsInN0YWNrIiwibGlzdGVuSGFuZGxlIiwib25Ta2lwcGVkRW50cmllcyIsIndhaXRVbnRpbENhdWdodFVwIiwibGFzdEVudHJ5IiwiJG5hdHVyYWwiLCJfc2xlZXBGb3JNcyIsImxlc3NUaGFuT3JFcXVhbCIsImluc2VydEFmdGVyIiwiZ3JlYXRlclRoYW4iLCJzcGxpY2UiLCJtb25nb2RiVXJpIiwicGFyc2UiLCJkYXRhYmFzZSIsImFkbWluIiwiY29tbWFuZCIsImlzbWFzdGVyIiwic2V0TmFtZSIsImxhc3RPcGxvZ0VudHJ5Iiwib3Bsb2dTZWxlY3RvciIsIl9tYXliZVN0YXJ0V29ya2VyIiwicmV0dXJuIiwiaXNFbXB0eSIsInBvcCIsImNsZWFyIiwiX3NldExhc3RQcm9jZXNzZWRUUyIsInNoaWZ0IiwiSlNPTiIsImZpcmUiLCJzZXF1ZW5jZXIiLCJfZGVmaW5lVG9vRmFyQmVoaW5kIiwiX3Jlc2V0VG9vRmFyQmVoaW5kIiwiZmFjdHMiLCJGYWN0cyIsImluY3JlbWVudFNlcnZlckZhY3QiLCJfb3JkZXJlZCIsIl9vblN0b3AiLCJfcXVldWUiLCJfU3luY2hyb25vdXNRdWV1ZSIsIl9oYW5kbGVzIiwiX2NhY2hlIiwiX0NhY2hpbmdDaGFuZ2VPYnNlcnZlciIsIl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZCIsImNhbGxiYWNrTmFtZXMiLCJjYWxsYmFja05hbWUiLCJfYXBwbHlDYWxsYmFjayIsInRvQXJyYXkiLCJoYW5kbGUiLCJzYWZlVG9SdW5UYXNrIiwicnVuVGFzayIsIl9zZW5kQWRkcyIsInJlbW92ZUhhbmRsZSIsIl9yZWFkeSIsIl9zdG9wIiwiZnJvbVF1ZXJ5RXJyb3IiLCJyZWFkeSIsInF1ZXVlVGFzayIsInF1ZXJ5RXJyb3IiLCJ0aHJvdyIsIm9uRmx1c2giLCJpc1Jlc29sdmVkIiwiYXJncyIsImFwcGx5Q2hhbmdlIiwia2V5cyIsImhhbmRsZUlkIiwiYWRkIiwiX2FkZGVkQmVmb3JlIiwiX2FkZGVkIiwiZG9jcyIsIm5leHRPYnNlcnZlSGFuZGxlSWQiLCJfbXVsdGlwbGV4ZXIiLCJiZWZvcmUiLCJGaWJlciIsIm1vbmdvQ29ubmVjdGlvbiIsIl9tb25nb0Nvbm5lY3Rpb24iLCJfY2FsbGJhY2tzRm9yQ2FjaGVLZXkiLCJjYWNoZUtleSIsImNoZWNrIiwiU3RyaW5nIiwiY2xvbmVkRG9jIiwicnVuIiwiX21vbmdvSGFuZGxlIiwiX3N0b3BDYWxsYmFja3MiLCJfcmVzdWx0cyIsIl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQiLCJfcGVuZGluZ1dyaXRlcyIsIl9lbnN1cmVQb2xsSXNTY2hlZHVsZWQiLCJ0aHJvdHRsZSIsIl91bnRocm90dGxlZEVuc3VyZVBvbGxJc1NjaGVkdWxlZCIsInBvbGxpbmdUaHJvdHRsZU1zIiwiX3Rhc2tRdWV1ZSIsImxpc3RlbmVyc0hhbmRsZSIsInBvbGxpbmdJbnRlcnZhbCIsInBvbGxpbmdJbnRlcnZhbE1zIiwiX3BvbGxpbmdJbnRlcnZhbCIsImludGVydmFsSGFuZGxlIiwic2V0SW50ZXJ2YWwiLCJjbGVhckludGVydmFsIiwiX3BvbGxNb25nbyIsIl9zdXNwZW5kUG9sbGluZyIsIl9yZXN1bWVQb2xsaW5nIiwiZmlyc3QiLCJuZXdSZXN1bHRzIiwib2xkUmVzdWx0cyIsIndyaXRlc0ZvckN5Y2xlIiwiY29kZSIsIm1lc3NhZ2UiLCJBcnJheSIsIl9kaWZmUXVlcnlDaGFuZ2VzIiwidyIsImMiLCJQSEFTRSIsIlFVRVJZSU5HIiwiRkVUQ0hJTkciLCJTVEVBRFkiLCJTd2l0Y2hlZFRvUXVlcnkiLCJmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeSIsImN1cnJlbnRJZCIsIl91c2VzT3Bsb2ciLCJjb21wYXJhdG9yIiwiZ2V0Q29tcGFyYXRvciIsImhlYXBPcHRpb25zIiwiSWRNYXAiLCJfbGltaXQiLCJfY29tcGFyYXRvciIsIl9zb3J0ZXIiLCJfdW5wdWJsaXNoZWRCdWZmZXIiLCJNaW5NYXhIZWFwIiwiX3B1Ymxpc2hlZCIsIk1heEhlYXAiLCJfc2FmZUFwcGVuZFRvQnVmZmVyIiwiX3N0b3BIYW5kbGVzIiwiX3JlZ2lzdGVyUGhhc2VDaGFuZ2UiLCJfbWF0Y2hlciIsInByb2plY3Rpb24iLCJfcHJvamVjdGlvbkZuIiwiX2NvbXBpbGVQcm9qZWN0aW9uIiwiX3NoYXJlZFByb2plY3Rpb24iLCJjb21iaW5lSW50b1Byb2plY3Rpb24iLCJfc2hhcmVkUHJvamVjdGlvbkZuIiwiX25lZWRUb0ZldGNoIiwiX2N1cnJlbnRseUZldGNoaW5nIiwiX2ZldGNoR2VuZXJhdGlvbiIsIl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkiLCJfd3JpdGVzVG9Db21taXRXaGVuV2VSZWFjaFN0ZWFkeSIsIl9uZWVkVG9Qb2xsUXVlcnkiLCJfcGhhc2UiLCJfaGFuZGxlT3Bsb2dFbnRyeVF1ZXJ5aW5nIiwiX2hhbmRsZU9wbG9nRW50cnlTdGVhZHlPckZldGNoaW5nIiwiZmlyZWQiLCJfb3Bsb2dPYnNlcnZlRHJpdmVycyIsIm9uQmVmb3JlRmlyZSIsImRyaXZlcnMiLCJkcml2ZXIiLCJfcnVuSW5pdGlhbFF1ZXJ5IiwiX2FkZFB1Ymxpc2hlZCIsIm92ZXJmbG93aW5nRG9jSWQiLCJtYXhFbGVtZW50SWQiLCJvdmVyZmxvd2luZ0RvYyIsImVxdWFscyIsInJlbW92ZWQiLCJfYWRkQnVmZmVyZWQiLCJfcmVtb3ZlUHVibGlzaGVkIiwiZW1wdHkiLCJuZXdEb2NJZCIsIm1pbkVsZW1lbnRJZCIsIl9yZW1vdmVCdWZmZXJlZCIsIl9jaGFuZ2VQdWJsaXNoZWQiLCJvbGREb2MiLCJwcm9qZWN0ZWROZXciLCJwcm9qZWN0ZWRPbGQiLCJjaGFuZ2VkIiwiRGlmZlNlcXVlbmNlIiwibWFrZUNoYW5nZWRGaWVsZHMiLCJtYXhCdWZmZXJlZElkIiwiX2FkZE1hdGNoaW5nIiwibWF4UHVibGlzaGVkIiwibWF4QnVmZmVyZWQiLCJ0b1B1Ymxpc2giLCJjYW5BcHBlbmRUb0J1ZmZlciIsImNhbkluc2VydEludG9CdWZmZXIiLCJ0b0J1ZmZlciIsIl9yZW1vdmVNYXRjaGluZyIsIl9oYW5kbGVEb2MiLCJtYXRjaGVzTm93IiwiZG9jdW1lbnRNYXRjaGVzIiwicHVibGlzaGVkQmVmb3JlIiwiYnVmZmVyZWRCZWZvcmUiLCJjYWNoZWRCZWZvcmUiLCJtaW5CdWZmZXJlZCIsInN0YXlzSW5QdWJsaXNoZWQiLCJzdGF5c0luQnVmZmVyIiwiX2ZldGNoTW9kaWZpZWREb2N1bWVudHMiLCJ0aGlzR2VuZXJhdGlvbiIsIndhaXRpbmciLCJmdXQiLCJfYmVTdGVhZHkiLCJ3cml0ZXMiLCJ0b1N0cmluZyIsImlzUmVwbGFjZSIsImNhbkRpcmVjdGx5TW9kaWZ5RG9jIiwibW9kaWZpZXJDYW5CZURpcmVjdGx5QXBwbGllZCIsIl9tb2RpZnkiLCJjYW5CZWNvbWVUcnVlQnlNb2RpZmllciIsImFmZmVjdGVkQnlNb2RpZmllciIsIl9ydW5RdWVyeSIsImluaXRpYWwiLCJfZG9uZVF1ZXJ5aW5nIiwiX3BvbGxRdWVyeSIsIm5ld0J1ZmZlciIsIl9jdXJzb3JGb3JRdWVyeSIsImkiLCJfcHVibGlzaE5ld1Jlc3VsdHMiLCJvcHRpb25zT3ZlcndyaXRlIiwiZGVzY3JpcHRpb24iLCJpZHNUb1JlbW92ZSIsIl9vcGxvZ0VudHJ5SGFuZGxlIiwiX2xpc3RlbmVyc0hhbmRsZSIsInBoYXNlIiwibm93IiwiRGF0ZSIsInRpbWVEaWZmIiwiX3BoYXNlU3RhcnRUaW1lIiwiZGlzYWJsZU9wbG9nIiwiX2Rpc2FibGVPcGxvZyIsIl9jaGVja1N1cHBvcnRlZFByb2plY3Rpb24iLCJoYXNXaGVyZSIsImhhc0dlb1F1ZXJ5IiwibW9kaWZpZXIiLCJvcGVyYXRpb24iLCJmaWVsZCIsImV4cG9ydCIsIkxvY2FsQ29sbGVjdGlvbkRyaXZlciIsImNvbnN0cnVjdG9yIiwibm9Db25uQ29sbGVjdGlvbnMiLCJjcmVhdGUiLCJvcGVuIiwiY29ubiIsImVuc3VyZUNvbGxlY3Rpb24iLCJfbW9uZ29fbGl2ZWRhdGFfY29sbGVjdGlvbnMiLCJjb2xsZWN0aW9ucyIsIlJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIiLCJtb25nb191cmwiLCJtIiwiZGVmYXVsdFJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIiLCJvbmNlIiwiY29ubmVjdGlvbk9wdGlvbnMiLCJtb25nb1VybCIsIk1PTkdPX1VSTCIsIk1PTkdPX09QTE9HX1VSTCIsImNvbm5lY3Rpb24iLCJtYW5hZ2VyIiwiaWRHZW5lcmF0aW9uIiwiX2RyaXZlciIsIl9wcmV2ZW50QXV0b3B1Ymxpc2giLCJfbWFrZU5ld0lEIiwic3JjIiwiRERQIiwicmFuZG9tU3RyZWFtIiwiUmFuZG9tIiwiaW5zZWN1cmUiLCJoZXhTdHJpbmciLCJfY29ubmVjdGlvbiIsImlzQ2xpZW50Iiwic2VydmVyIiwiX2NvbGxlY3Rpb24iLCJfbmFtZSIsIl9tYXliZVNldFVwUmVwbGljYXRpb24iLCJkZWZpbmVNdXRhdGlvbk1ldGhvZHMiLCJfZGVmaW5lTXV0YXRpb25NZXRob2RzIiwidXNlRXhpc3RpbmciLCJfc3VwcHJlc3NTYW1lTmFtZUVycm9yIiwiYXV0b3B1Ymxpc2giLCJwdWJsaXNoIiwiaXNfYXV0byIsInJlZ2lzdGVyU3RvcmUiLCJvayIsImJlZ2luVXBkYXRlIiwiYmF0Y2hTaXplIiwicmVzZXQiLCJwYXVzZU9ic2VydmVycyIsIm1zZyIsIm1vbmdvSWQiLCJNb25nb0lEIiwiaWRQYXJzZSIsInJlcGxhY2UiLCIkdW5zZXQiLCIkc2V0IiwiZW5kVXBkYXRlIiwicmVzdW1lT2JzZXJ2ZXJzIiwic2F2ZU9yaWdpbmFscyIsInJldHJpZXZlT3JpZ2luYWxzIiwiZ2V0RG9jIiwiX2dldENvbGxlY3Rpb24iLCJjb25zb2xlIiwid2FybiIsImxvZyIsIl9nZXRGaW5kU2VsZWN0b3IiLCJfZ2V0RmluZE9wdGlvbnMiLCJNYXRjaCIsIk9wdGlvbmFsIiwiT2JqZWN0SW5jbHVkaW5nIiwiT25lT2YiLCJOdW1iZXIiLCJmYWxsYmFja0lkIiwiX3NlbGVjdG9ySXNJZCIsImdldFByb3RvdHlwZU9mIiwiZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9ycyIsImdlbmVyYXRlSWQiLCJfaXNSZW1vdGVDb2xsZWN0aW9uIiwiZW5jbG9zaW5nIiwiX0N1cnJlbnRNZXRob2RJbnZvY2F0aW9uIiwiY2hvb3NlUmV0dXJuVmFsdWVGcm9tQ29sbGVjdGlvblJlc3VsdCIsIndyYXBDYWxsYmFjayIsIl9jYWxsTXV0YXRvck1ldGhvZCIsIm9wdGlvbnNBbmRDYWxsYmFjayIsInBvcENhbGxiYWNrRnJvbUFyZ3MiLCJyYXdEYXRhYmFzZSIsImNvbnZlcnRSZXN1bHQiLCJBbGxvd0RlbnkiLCJDb2xsZWN0aW9uUHJvdG90eXBlIiwic2V0Q29ubmVjdGlvbk9wdGlvbnMiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBOzs7Ozs7OztBQVNBLElBQUlBLFVBQVVDLGdCQUFkOztBQUNBLElBQUlDLFNBQVNDLElBQUlDLE9BQUosQ0FBWSxlQUFaLENBQWI7O0FBRUFDLGlCQUFpQixFQUFqQjtBQUNBQyxZQUFZLEVBQVo7QUFFQUQsZUFBZUUsVUFBZixHQUE0QjtBQUMxQkMsV0FBUztBQUNQQyxhQUFTQyx1QkFERjtBQUVQQyxZQUFRWDtBQUZEO0FBRGlCLENBQTVCLEMsQ0FPQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQUssZUFBZU8sU0FBZixHQUEyQlosT0FBM0IsQyxDQUVBO0FBQ0E7O0FBQ0EsSUFBSWEsZUFBZSxVQUFVQyxNQUFWLEVBQWtCQyxLQUFsQixFQUF5QjtBQUMxQyxNQUFJLE9BQU9BLEtBQVAsS0FBaUIsUUFBckIsRUFBK0I7QUFDN0IsUUFBSUMsRUFBRUMsT0FBRixDQUFVRixLQUFWLENBQUosRUFBc0I7QUFDcEIsYUFBT0MsRUFBRUUsR0FBRixDQUFNSCxLQUFOLEVBQWFDLEVBQUVHLElBQUYsQ0FBT04sWUFBUCxFQUFxQixJQUFyQixFQUEyQkMsTUFBM0IsQ0FBYixDQUFQO0FBQ0Q7O0FBQ0QsUUFBSU0sTUFBTSxFQUFWOztBQUNBSixNQUFFSyxJQUFGLENBQU9OLEtBQVAsRUFBYyxVQUFVTyxLQUFWLEVBQWlCQyxHQUFqQixFQUFzQjtBQUNsQ0gsVUFBSU4sT0FBT1MsR0FBUCxDQUFKLElBQW1CVixhQUFhQyxNQUFiLEVBQXFCUSxLQUFyQixDQUFuQjtBQUNELEtBRkQ7O0FBR0EsV0FBT0YsR0FBUDtBQUNEOztBQUNELFNBQU9MLEtBQVA7QUFDRCxDQVpELEMsQ0FjQTtBQUNBO0FBQ0E7OztBQUNBZixRQUFRd0IsU0FBUixDQUFrQkMsU0FBbEIsQ0FBNEJDLEtBQTVCLEdBQW9DLFlBQVk7QUFDOUM7QUFDQSxTQUFPLElBQVA7QUFDRCxDQUhEOztBQUtBLElBQUlDLGlCQUFpQixVQUFVQyxJQUFWLEVBQWdCO0FBQUUsU0FBTyxVQUFVQSxJQUFqQjtBQUF3QixDQUEvRDs7QUFDQSxJQUFJQyxtQkFBbUIsVUFBVUQsSUFBVixFQUFnQjtBQUFFLFNBQU9BLEtBQUtFLE1BQUwsQ0FBWSxDQUFaLENBQVA7QUFBd0IsQ0FBakU7O0FBRUEsSUFBSUMsNkJBQTZCLFVBQVVDLFFBQVYsRUFBb0I7QUFDbkQsTUFBSUEsb0JBQW9CaEMsUUFBUWlDLE1BQWhDLEVBQXdDO0FBQ3RDLFFBQUlDLFNBQVNGLFNBQVNWLEtBQVQsQ0FBZSxJQUFmLENBQWI7QUFDQSxXQUFPLElBQUlhLFVBQUosQ0FBZUQsTUFBZixDQUFQO0FBQ0Q7O0FBQ0QsTUFBSUYsb0JBQW9CaEMsUUFBUW9DLFFBQWhDLEVBQTBDO0FBQ3hDLFdBQU8sSUFBSUMsTUFBTUQsUUFBVixDQUFtQkosU0FBU00sV0FBVCxFQUFuQixDQUFQO0FBQ0Q7O0FBQ0QsTUFBSU4sU0FBUyxZQUFULEtBQTBCQSxTQUFTLGFBQVQsQ0FBMUIsSUFBcURoQixFQUFFdUIsSUFBRixDQUFPUCxRQUFQLE1BQXFCLENBQTlFLEVBQWlGO0FBQy9FLFdBQU9RLE1BQU1DLGFBQU4sQ0FBb0I1QixhQUFhZ0IsZ0JBQWIsRUFBK0JHLFFBQS9CLENBQXBCLENBQVA7QUFDRDs7QUFDRCxNQUFJQSxvQkFBb0JoQyxRQUFRd0IsU0FBaEMsRUFBMkM7QUFDekM7QUFDQTtBQUNBO0FBQ0E7QUFDQSxXQUFPUSxRQUFQO0FBQ0Q7O0FBQ0QsU0FBT1UsU0FBUDtBQUNELENBbkJEOztBQXFCQSxJQUFJQyw2QkFBNkIsVUFBVVgsUUFBVixFQUFvQjtBQUNuRCxNQUFJUSxNQUFNSSxRQUFOLENBQWVaLFFBQWYsQ0FBSixFQUE4QjtBQUM1QjtBQUNBO0FBQ0E7QUFDQSxXQUFPLElBQUloQyxRQUFRaUMsTUFBWixDQUFtQlksT0FBT0MsSUFBUCxDQUFZZCxRQUFaLENBQW5CLENBQVA7QUFDRDs7QUFDRCxNQUFJQSxvQkFBb0JLLE1BQU1ELFFBQTlCLEVBQXdDO0FBQ3RDLFdBQU8sSUFBSXBDLFFBQVFvQyxRQUFaLENBQXFCSixTQUFTTSxXQUFULEVBQXJCLENBQVA7QUFDRDs7QUFDRCxNQUFJTixvQkFBb0JoQyxRQUFRd0IsU0FBaEMsRUFBMkM7QUFDekM7QUFDQTtBQUNBO0FBQ0E7QUFDQSxXQUFPUSxRQUFQO0FBQ0Q7O0FBQ0QsTUFBSVEsTUFBTU8sYUFBTixDQUFvQmYsUUFBcEIsQ0FBSixFQUFtQztBQUNqQyxXQUFPbkIsYUFBYWMsY0FBYixFQUE2QmEsTUFBTVEsV0FBTixDQUFrQmhCLFFBQWxCLENBQTdCLENBQVA7QUFDRCxHQW5Ca0QsQ0FvQm5EO0FBQ0E7OztBQUNBLFNBQU9VLFNBQVA7QUFDRCxDQXZCRDs7QUF5QkEsSUFBSU8sZUFBZSxVQUFVakIsUUFBVixFQUFvQmtCLGVBQXBCLEVBQXFDO0FBQ3RELE1BQUksT0FBT2xCLFFBQVAsS0FBb0IsUUFBcEIsSUFBZ0NBLGFBQWEsSUFBakQsRUFDRSxPQUFPQSxRQUFQO0FBRUYsTUFBSW1CLHVCQUF1QkQsZ0JBQWdCbEIsUUFBaEIsQ0FBM0I7QUFDQSxNQUFJbUIseUJBQXlCVCxTQUE3QixFQUNFLE9BQU9TLG9CQUFQO0FBRUYsTUFBSS9CLE1BQU1ZLFFBQVY7O0FBQ0FoQixJQUFFSyxJQUFGLENBQU9XLFFBQVAsRUFBaUIsVUFBVW9CLEdBQVYsRUFBZTdCLEdBQWYsRUFBb0I7QUFDbkMsUUFBSThCLGNBQWNKLGFBQWFHLEdBQWIsRUFBa0JGLGVBQWxCLENBQWxCOztBQUNBLFFBQUlFLFFBQVFDLFdBQVosRUFBeUI7QUFDdkI7QUFDQSxVQUFJakMsUUFBUVksUUFBWixFQUNFWixNQUFNSixFQUFFVSxLQUFGLENBQVFNLFFBQVIsQ0FBTjtBQUNGWixVQUFJRyxHQUFKLElBQVc4QixXQUFYO0FBQ0Q7QUFDRixHQVJEOztBQVNBLFNBQU9qQyxHQUFQO0FBQ0QsQ0FuQkQ7O0FBc0JBa0Msa0JBQWtCLFVBQVVDLEdBQVYsRUFBZUMsT0FBZixFQUF3QjtBQUN4QyxNQUFJQyxPQUFPLElBQVg7QUFDQUQsWUFBVUEsV0FBVyxFQUFyQjtBQUNBQyxPQUFLQyxvQkFBTCxHQUE0QixFQUE1QjtBQUNBRCxPQUFLRSxlQUFMLEdBQXVCLElBQUlDLElBQUosRUFBdkI7QUFFQSxNQUFJQyxlQUFlQyxPQUFPQyxNQUFQLENBQWM7QUFDL0I7QUFDQUMsbUJBQWUsSUFGZ0I7QUFHL0I7QUFDQTtBQUNBQyxvQkFBZ0JDLFFBTGU7QUFNL0JDLHFCQUFpQjtBQU5jLEdBQWQsRUFPaEI5QixNQUFNK0Isa0JBUFUsQ0FBbkIsQ0FOd0MsQ0FleEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxNQUFJLENBQUUsMEJBQTBCQyxJQUExQixDQUErQmQsR0FBL0IsQ0FBTixFQUE0QztBQUMxQ00saUJBQWFTLGFBQWIsR0FBNkIsS0FBN0I7QUFDRCxHQXpCdUMsQ0EyQnhDO0FBQ0E7OztBQUNBLE1BQUl0RCxFQUFFdUQsR0FBRixDQUFNZixPQUFOLEVBQWUsVUFBZixDQUFKLEVBQWdDO0FBQzlCO0FBQ0E7QUFDQUssaUJBQWFXLFFBQWIsR0FBd0JoQixRQUFRZ0IsUUFBaEM7QUFDRDs7QUFFRGYsT0FBS2dCLEVBQUwsR0FBVSxJQUFWLENBbkN3QyxDQW9DeEM7QUFDQTtBQUNBOztBQUNBaEIsT0FBS2lCLFFBQUwsR0FBZ0IsSUFBaEI7QUFDQWpCLE9BQUtrQixZQUFMLEdBQW9CLElBQXBCO0FBQ0FsQixPQUFLbUIsV0FBTCxHQUFtQixJQUFuQjtBQUdBLE1BQUlDLGdCQUFnQixJQUFJM0UsTUFBSixFQUFwQjtBQUNBRixVQUFROEUsT0FBUixDQUNFdkIsR0FERixFQUVFTSxZQUZGLEVBR0VrQixPQUFPQyxlQUFQLENBQ0UsVUFBVUMsR0FBVixFQUFlUixFQUFmLEVBQW1CO0FBQ2pCLFFBQUlRLEdBQUosRUFBUztBQUNQLFlBQU1BLEdBQU47QUFDRCxLQUhnQixDQUtqQjs7O0FBQ0EsUUFBSVIsR0FBR1MsWUFBSCxDQUFnQkMsV0FBcEIsRUFBaUM7QUFDL0IxQixXQUFLaUIsUUFBTCxHQUFnQkQsR0FBR1MsWUFBSCxDQUFnQkMsV0FBaEIsQ0FBNEJDLE9BQTVDO0FBQ0Q7O0FBRURYLE9BQUdTLFlBQUgsQ0FBZ0JHLEVBQWhCLENBQ0UsUUFERixFQUNZTixPQUFPQyxlQUFQLENBQXVCLFVBQVVNLElBQVYsRUFBZ0JDLEdBQWhCLEVBQXFCO0FBQ3BELFVBQUlELFNBQVMsU0FBYixFQUF3QjtBQUN0QixZQUFJQyxJQUFJSCxPQUFKLEtBQWdCM0IsS0FBS2lCLFFBQXpCLEVBQW1DO0FBQ2pDakIsZUFBS2lCLFFBQUwsR0FBZ0JhLElBQUlILE9BQXBCOztBQUNBM0IsZUFBS0UsZUFBTCxDQUFxQnRDLElBQXJCLENBQTBCLFVBQVVtRSxRQUFWLEVBQW9CO0FBQzVDQTtBQUNBLG1CQUFPLElBQVA7QUFDRCxXQUhEO0FBSUQ7QUFDRixPQVJELE1BUU8sSUFBSUQsSUFBSUUsRUFBSixLQUFXaEMsS0FBS2lCLFFBQXBCLEVBQThCO0FBQ25DO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQWpCLGFBQUtpQixRQUFMLEdBQWdCLElBQWhCO0FBQ0Q7QUFDRixLQWpCUyxDQURaLEVBVmlCLENBOEJqQjs7QUFDQUcsa0JBQWMsUUFBZCxFQUF3QkosRUFBeEI7QUFDRCxHQWpDSCxFQWtDRUksY0FBY2EsUUFBZCxFQWxDRixDQWtDNEI7QUFsQzVCLEdBSEYsRUE3Q3dDLENBc0Z4Qzs7QUFDQWpDLE9BQUtnQixFQUFMLEdBQVVJLGNBQWNjLElBQWQsRUFBVjs7QUFFQSxNQUFJbkMsUUFBUW9DLFFBQVIsSUFBb0IsQ0FBRUMsUUFBUSxlQUFSLENBQTFCLEVBQW9EO0FBQ2xEcEMsU0FBS2tCLFlBQUwsR0FBb0IsSUFBSW1CLFdBQUosQ0FBZ0J0QyxRQUFRb0MsUUFBeEIsRUFBa0NuQyxLQUFLZ0IsRUFBTCxDQUFRc0IsWUFBMUMsQ0FBcEI7QUFDQXRDLFNBQUttQixXQUFMLEdBQW1CLElBQUlvQixVQUFKLENBQWV2QyxJQUFmLENBQW5CO0FBQ0Q7QUFDRixDQTdGRDs7QUErRkFILGdCQUFnQjdCLFNBQWhCLENBQTBCd0UsS0FBMUIsR0FBa0MsWUFBVztBQUMzQyxNQUFJeEMsT0FBTyxJQUFYO0FBRUEsTUFBSSxDQUFFQSxLQUFLZ0IsRUFBWCxFQUNFLE1BQU15QixNQUFNLHlDQUFOLENBQU4sQ0FKeUMsQ0FNM0M7O0FBQ0EsTUFBSUMsY0FBYzFDLEtBQUtrQixZQUF2QjtBQUNBbEIsT0FBS2tCLFlBQUwsR0FBb0IsSUFBcEI7QUFDQSxNQUFJd0IsV0FBSixFQUNFQSxZQUFZQyxJQUFaLEdBVnlDLENBWTNDO0FBQ0E7QUFDQTs7QUFDQWxHLFNBQU9tRyxJQUFQLENBQVlyRixFQUFFRyxJQUFGLENBQU9zQyxLQUFLZ0IsRUFBTCxDQUFRd0IsS0FBZixFQUFzQnhDLEtBQUtnQixFQUEzQixDQUFaLEVBQTRDLElBQTVDLEVBQWtEa0IsSUFBbEQ7QUFDRCxDQWhCRCxDLENBa0JBOzs7QUFDQXJDLGdCQUFnQjdCLFNBQWhCLENBQTBCNkUsYUFBMUIsR0FBMEMsVUFBVUMsY0FBVixFQUEwQjtBQUNsRSxNQUFJOUMsT0FBTyxJQUFYO0FBRUEsTUFBSSxDQUFFQSxLQUFLZ0IsRUFBWCxFQUNFLE1BQU15QixNQUFNLGlEQUFOLENBQU47QUFFRixNQUFJTSxTQUFTLElBQUl0RyxNQUFKLEVBQWI7QUFDQXVELE9BQUtnQixFQUFMLENBQVFnQyxVQUFSLENBQW1CRixjQUFuQixFQUFtQ0MsT0FBT2QsUUFBUCxFQUFuQztBQUNBLFNBQU9jLE9BQU9iLElBQVAsRUFBUDtBQUNELENBVEQ7O0FBV0FyQyxnQkFBZ0I3QixTQUFoQixDQUEwQmlGLHVCQUExQixHQUFvRCxVQUNoREgsY0FEZ0QsRUFDaENJLFFBRGdDLEVBQ3RCQyxZQURzQixFQUNSO0FBQzFDLE1BQUluRCxPQUFPLElBQVg7QUFFQSxNQUFJLENBQUVBLEtBQUtnQixFQUFYLEVBQ0UsTUFBTXlCLE1BQU0sMkRBQU4sQ0FBTjtBQUVGLE1BQUlNLFNBQVMsSUFBSXRHLE1BQUosRUFBYjtBQUNBdUQsT0FBS2dCLEVBQUwsQ0FBUW9DLGdCQUFSLENBQ0VOLGNBREYsRUFFRTtBQUFFTyxZQUFRLElBQVY7QUFBZ0J2RSxVQUFNb0UsUUFBdEI7QUFBZ0NJLFNBQUtIO0FBQXJDLEdBRkYsRUFHRUosT0FBT2QsUUFBUCxFQUhGO0FBSUFjLFNBQU9iLElBQVA7QUFDRCxDQWJELEMsQ0FlQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQXJDLGdCQUFnQjdCLFNBQWhCLENBQTBCdUYsZ0JBQTFCLEdBQTZDLFlBQVk7QUFDdkQsTUFBSUMsUUFBUUMsVUFBVUMsa0JBQVYsQ0FBNkJDLEdBQTdCLEVBQVo7O0FBQ0EsTUFBSUgsS0FBSixFQUFXO0FBQ1QsV0FBT0EsTUFBTUksVUFBTixFQUFQO0FBQ0QsR0FGRCxNQUVPO0FBQ0wsV0FBTztBQUFDQyxpQkFBVyxZQUFZLENBQUU7QUFBMUIsS0FBUDtBQUNEO0FBQ0YsQ0FQRCxDLENBU0E7QUFDQTs7O0FBQ0FoRSxnQkFBZ0I3QixTQUFoQixDQUEwQjhGLFdBQTFCLEdBQXdDLFVBQVUvQixRQUFWLEVBQW9CO0FBQzFELFNBQU8sS0FBSzdCLGVBQUwsQ0FBcUI2RCxRQUFyQixDQUE4QmhDLFFBQTlCLENBQVA7QUFDRCxDQUZELEMsQ0FLQTtBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBRUEsSUFBSWlDLGdCQUFnQixVQUFVQyxLQUFWLEVBQWlCQyxPQUFqQixFQUEwQm5DLFFBQTFCLEVBQW9DO0FBQ3RELFNBQU8sVUFBVVAsR0FBVixFQUFlMkMsTUFBZixFQUF1QjtBQUM1QixRQUFJLENBQUUzQyxHQUFOLEVBQVc7QUFDVDtBQUNBLFVBQUk7QUFDRjBDO0FBQ0QsT0FGRCxDQUVFLE9BQU9FLFVBQVAsRUFBbUI7QUFDbkIsWUFBSXJDLFFBQUosRUFBYztBQUNaQSxtQkFBU3FDLFVBQVQ7QUFDQTtBQUNELFNBSEQsTUFHTztBQUNMLGdCQUFNQSxVQUFOO0FBQ0Q7QUFDRjtBQUNGOztBQUNESCxVQUFNSixTQUFOOztBQUNBLFFBQUk5QixRQUFKLEVBQWM7QUFDWkEsZUFBU1AsR0FBVCxFQUFjMkMsTUFBZDtBQUNELEtBRkQsTUFFTyxJQUFJM0MsR0FBSixFQUFTO0FBQ2QsWUFBTUEsR0FBTjtBQUNEO0FBQ0YsR0FwQkQ7QUFxQkQsQ0F0QkQ7O0FBd0JBLElBQUk2QywwQkFBMEIsVUFBVXRDLFFBQVYsRUFBb0I7QUFDaEQsU0FBT1QsT0FBT0MsZUFBUCxDQUF1QlEsUUFBdkIsRUFBaUMsYUFBakMsQ0FBUDtBQUNELENBRkQ7O0FBSUFsQyxnQkFBZ0I3QixTQUFoQixDQUEwQnNHLE9BQTFCLEdBQW9DLFVBQVVDLGVBQVYsRUFBMkJoRyxRQUEzQixFQUNVd0QsUUFEVixFQUNvQjtBQUN0RCxNQUFJL0IsT0FBTyxJQUFYOztBQUVBLE1BQUl3RSxZQUFZLFVBQVVDLENBQVYsRUFBYTtBQUMzQixRQUFJMUMsUUFBSixFQUNFLE9BQU9BLFNBQVMwQyxDQUFULENBQVA7QUFDRixVQUFNQSxDQUFOO0FBQ0QsR0FKRDs7QUFNQSxNQUFJRixvQkFBb0IsbUNBQXhCLEVBQTZEO0FBQzNELFFBQUlFLElBQUksSUFBSWhDLEtBQUosQ0FBVSxjQUFWLENBQVI7QUFDQWdDLE1BQUVDLGVBQUYsR0FBb0IsSUFBcEI7QUFDQUYsY0FBVUMsQ0FBVjtBQUNBO0FBQ0Q7O0FBRUQsTUFBSSxFQUFFRSxnQkFBZ0JDLGNBQWhCLENBQStCckcsUUFBL0IsS0FDQSxDQUFDUSxNQUFNTyxhQUFOLENBQW9CZixRQUFwQixDQURILENBQUosRUFDdUM7QUFDckNpRyxjQUFVLElBQUkvQixLQUFKLENBQ1IsaURBRFEsQ0FBVjtBQUVBO0FBQ0Q7O0FBRUQsTUFBSXdCLFFBQVFqRSxLQUFLdUQsZ0JBQUwsRUFBWjs7QUFDQSxNQUFJVyxVQUFVLFlBQVk7QUFDeEI1QyxXQUFPNEMsT0FBUCxDQUFlO0FBQUNsQixrQkFBWXVCLGVBQWI7QUFBOEJNLFVBQUl0RyxTQUFTdUc7QUFBM0MsS0FBZjtBQUNELEdBRkQ7O0FBR0EvQyxhQUFXc0Msd0JBQXdCTCxjQUFjQyxLQUFkLEVBQXFCQyxPQUFyQixFQUE4Qm5DLFFBQTlCLENBQXhCLENBQVg7O0FBQ0EsTUFBSTtBQUNGLFFBQUlpQixhQUFhaEQsS0FBSzZDLGFBQUwsQ0FBbUIwQixlQUFuQixDQUFqQjtBQUNBdkIsZUFBVytCLE1BQVgsQ0FBa0J2RixhQUFhakIsUUFBYixFQUF1QlcsMEJBQXZCLENBQWxCLEVBQ2tCO0FBQUM4RixZQUFNO0FBQVAsS0FEbEIsRUFDZ0NqRCxRQURoQztBQUVELEdBSkQsQ0FJRSxPQUFPUCxHQUFQLEVBQVk7QUFDWnlDLFVBQU1KLFNBQU47QUFDQSxVQUFNckMsR0FBTjtBQUNEO0FBQ0YsQ0FyQ0QsQyxDQXVDQTtBQUNBOzs7QUFDQTNCLGdCQUFnQjdCLFNBQWhCLENBQTBCaUgsUUFBMUIsR0FBcUMsVUFBVW5DLGNBQVYsRUFBMEJvQyxRQUExQixFQUFvQztBQUN2RSxNQUFJQyxhQUFhO0FBQUNuQyxnQkFBWUY7QUFBYixHQUFqQixDQUR1RSxDQUV2RTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxNQUFJc0MsY0FBY1QsZ0JBQWdCVSxxQkFBaEIsQ0FBc0NILFFBQXRDLENBQWxCOztBQUNBLE1BQUlFLFdBQUosRUFBaUI7QUFDZjdILE1BQUVLLElBQUYsQ0FBT3dILFdBQVAsRUFBb0IsVUFBVVAsRUFBVixFQUFjO0FBQ2hDdkQsYUFBTzRDLE9BQVAsQ0FBZTNHLEVBQUUrSCxNQUFGLENBQVM7QUFBQ1QsWUFBSUE7QUFBTCxPQUFULEVBQW1CTSxVQUFuQixDQUFmO0FBQ0QsS0FGRDtBQUdELEdBSkQsTUFJTztBQUNMN0QsV0FBTzRDLE9BQVAsQ0FBZWlCLFVBQWY7QUFDRDtBQUNGLENBZEQ7O0FBZ0JBdEYsZ0JBQWdCN0IsU0FBaEIsQ0FBMEJ1SCxPQUExQixHQUFvQyxVQUFVaEIsZUFBVixFQUEyQlcsUUFBM0IsRUFDVW5ELFFBRFYsRUFDb0I7QUFDdEQsTUFBSS9CLE9BQU8sSUFBWDs7QUFFQSxNQUFJdUUsb0JBQW9CLG1DQUF4QixFQUE2RDtBQUMzRCxRQUFJRSxJQUFJLElBQUloQyxLQUFKLENBQVUsY0FBVixDQUFSO0FBQ0FnQyxNQUFFQyxlQUFGLEdBQW9CLElBQXBCOztBQUNBLFFBQUkzQyxRQUFKLEVBQWM7QUFDWixhQUFPQSxTQUFTMEMsQ0FBVCxDQUFQO0FBQ0QsS0FGRCxNQUVPO0FBQ0wsWUFBTUEsQ0FBTjtBQUNEO0FBQ0Y7O0FBRUQsTUFBSVIsUUFBUWpFLEtBQUt1RCxnQkFBTCxFQUFaOztBQUNBLE1BQUlXLFVBQVUsWUFBWTtBQUN4QmxFLFNBQUtpRixRQUFMLENBQWNWLGVBQWQsRUFBK0JXLFFBQS9CO0FBQ0QsR0FGRDs7QUFHQW5ELGFBQVdzQyx3QkFBd0JMLGNBQWNDLEtBQWQsRUFBcUJDLE9BQXJCLEVBQThCbkMsUUFBOUIsQ0FBeEIsQ0FBWDs7QUFFQSxNQUFJO0FBQ0YsUUFBSWlCLGFBQWFoRCxLQUFLNkMsYUFBTCxDQUFtQjBCLGVBQW5CLENBQWpCOztBQUNBLFFBQUlpQixrQkFBa0IsVUFBU2hFLEdBQVQsRUFBY2lFLFlBQWQsRUFBNEI7QUFDaEQxRCxlQUFTUCxHQUFULEVBQWNrRSxnQkFBZ0JELFlBQWhCLEVBQThCRSxjQUE1QztBQUNELEtBRkQ7O0FBR0EzQyxlQUFXNEMsTUFBWCxDQUFrQnBHLGFBQWEwRixRQUFiLEVBQXVCaEcsMEJBQXZCLENBQWxCLEVBQ21CO0FBQUM4RixZQUFNO0FBQVAsS0FEbkIsRUFDaUNRLGVBRGpDO0FBRUQsR0FQRCxDQU9FLE9BQU9oRSxHQUFQLEVBQVk7QUFDWnlDLFVBQU1KLFNBQU47QUFDQSxVQUFNckMsR0FBTjtBQUNEO0FBQ0YsQ0EvQkQ7O0FBaUNBM0IsZ0JBQWdCN0IsU0FBaEIsQ0FBMEI2SCxlQUExQixHQUE0QyxVQUFVL0MsY0FBVixFQUEwQmdELEVBQTFCLEVBQThCO0FBQ3hFLE1BQUk5RixPQUFPLElBQVg7O0FBRUEsTUFBSWlFLFFBQVFqRSxLQUFLdUQsZ0JBQUwsRUFBWjs7QUFDQSxNQUFJVyxVQUFVLFlBQVk7QUFDeEI1QyxXQUFPNEMsT0FBUCxDQUFlO0FBQUNsQixrQkFBWUYsY0FBYjtBQUE2QitCLFVBQUksSUFBakM7QUFDQ2tCLHNCQUFnQjtBQURqQixLQUFmO0FBRUQsR0FIRDs7QUFJQUQsT0FBS3pCLHdCQUF3QkwsY0FBY0MsS0FBZCxFQUFxQkMsT0FBckIsRUFBOEI0QixFQUE5QixDQUF4QixDQUFMOztBQUVBLE1BQUk7QUFDRixRQUFJOUMsYUFBYWhELEtBQUs2QyxhQUFMLENBQW1CQyxjQUFuQixDQUFqQjtBQUNBRSxlQUFXZ0QsSUFBWCxDQUFnQkYsRUFBaEI7QUFDRCxHQUhELENBR0UsT0FBT3JCLENBQVAsRUFBVTtBQUNWUixVQUFNSixTQUFOO0FBQ0EsVUFBTVksQ0FBTjtBQUNEO0FBQ0YsQ0FqQkQsQyxDQW1CQTtBQUNBOzs7QUFDQTVFLGdCQUFnQjdCLFNBQWhCLENBQTBCaUksYUFBMUIsR0FBMEMsVUFBVUgsRUFBVixFQUFjO0FBQ3RELE1BQUk5RixPQUFPLElBQVg7O0FBRUEsTUFBSWlFLFFBQVFqRSxLQUFLdUQsZ0JBQUwsRUFBWjs7QUFDQSxNQUFJVyxVQUFVLFlBQVk7QUFDeEI1QyxXQUFPNEMsT0FBUCxDQUFlO0FBQUVnQyxvQkFBYztBQUFoQixLQUFmO0FBQ0QsR0FGRDs7QUFHQUosT0FBS3pCLHdCQUF3QkwsY0FBY0MsS0FBZCxFQUFxQkMsT0FBckIsRUFBOEI0QixFQUE5QixDQUF4QixDQUFMOztBQUVBLE1BQUk7QUFDRjlGLFNBQUtnQixFQUFMLENBQVFrRixZQUFSLENBQXFCSixFQUFyQjtBQUNELEdBRkQsQ0FFRSxPQUFPckIsQ0FBUCxFQUFVO0FBQ1ZSLFVBQU1KLFNBQU47QUFDQSxVQUFNWSxDQUFOO0FBQ0Q7QUFDRixDQWZEOztBQWlCQTVFLGdCQUFnQjdCLFNBQWhCLENBQTBCbUksT0FBMUIsR0FBb0MsVUFBVTVCLGVBQVYsRUFBMkJXLFFBQTNCLEVBQXFDa0IsR0FBckMsRUFDVXJHLE9BRFYsRUFDbUJnQyxRQURuQixFQUM2QjtBQUMvRCxNQUFJL0IsT0FBTyxJQUFYOztBQUVBLE1BQUksQ0FBRStCLFFBQUYsSUFBY2hDLG1CQUFtQnNHLFFBQXJDLEVBQStDO0FBQzdDdEUsZUFBV2hDLE9BQVg7QUFDQUEsY0FBVSxJQUFWO0FBQ0Q7O0FBRUQsTUFBSXdFLG9CQUFvQixtQ0FBeEIsRUFBNkQ7QUFDM0QsUUFBSUUsSUFBSSxJQUFJaEMsS0FBSixDQUFVLGNBQVYsQ0FBUjtBQUNBZ0MsTUFBRUMsZUFBRixHQUFvQixJQUFwQjs7QUFDQSxRQUFJM0MsUUFBSixFQUFjO0FBQ1osYUFBT0EsU0FBUzBDLENBQVQsQ0FBUDtBQUNELEtBRkQsTUFFTztBQUNMLFlBQU1BLENBQU47QUFDRDtBQUNGLEdBaEI4RCxDQWtCL0Q7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBQ0EsTUFBSSxDQUFDMkIsR0FBRCxJQUFRLE9BQU9BLEdBQVAsS0FBZSxRQUEzQixFQUNFLE1BQU0sSUFBSTNELEtBQUosQ0FBVSwrQ0FBVixDQUFOOztBQUVGLE1BQUksRUFBRWtDLGdCQUFnQkMsY0FBaEIsQ0FBK0J3QixHQUEvQixLQUNBLENBQUNySCxNQUFNTyxhQUFOLENBQW9COEcsR0FBcEIsQ0FESCxDQUFKLEVBQ2tDO0FBQ2hDLFVBQU0sSUFBSTNELEtBQUosQ0FDSixrREFDRSx1QkFGRSxDQUFOO0FBR0Q7O0FBRUQsTUFBSSxDQUFDMUMsT0FBTCxFQUFjQSxVQUFVLEVBQVY7O0FBRWQsTUFBSWtFLFFBQVFqRSxLQUFLdUQsZ0JBQUwsRUFBWjs7QUFDQSxNQUFJVyxVQUFVLFlBQVk7QUFDeEJsRSxTQUFLaUYsUUFBTCxDQUFjVixlQUFkLEVBQStCVyxRQUEvQjtBQUNELEdBRkQ7O0FBR0FuRCxhQUFXaUMsY0FBY0MsS0FBZCxFQUFxQkMsT0FBckIsRUFBOEJuQyxRQUE5QixDQUFYOztBQUNBLE1BQUk7QUFDRixRQUFJaUIsYUFBYWhELEtBQUs2QyxhQUFMLENBQW1CMEIsZUFBbkIsQ0FBakI7QUFDQSxRQUFJK0IsWUFBWTtBQUFDdEIsWUFBTTtBQUFQLEtBQWhCLENBRkUsQ0FHRjs7QUFDQSxRQUFJakYsUUFBUXdHLE1BQVosRUFBb0JELFVBQVVDLE1BQVYsR0FBbUIsSUFBbkI7QUFDcEIsUUFBSXhHLFFBQVF5RyxLQUFaLEVBQW1CRixVQUFVRSxLQUFWLEdBQWtCLElBQWxCLENBTGpCLENBTUY7QUFDQTtBQUNBOztBQUNBLFFBQUl6RyxRQUFRMEcsVUFBWixFQUF3QkgsVUFBVUcsVUFBVixHQUF1QixJQUF2QjtBQUV4QixRQUFJQyxnQkFBZ0JsSCxhQUFhMEYsUUFBYixFQUF1QmhHLDBCQUF2QixDQUFwQjtBQUNBLFFBQUl5SCxXQUFXbkgsYUFBYTRHLEdBQWIsRUFBa0JsSCwwQkFBbEIsQ0FBZjs7QUFFQSxRQUFJMEgsV0FBV2pDLGdCQUFnQmtDLGtCQUFoQixDQUFtQ0YsUUFBbkMsQ0FBZjs7QUFFQSxRQUFJNUcsUUFBUStHLGNBQVIsSUFBMEIsQ0FBQ0YsUUFBL0IsRUFBeUM7QUFDdkMsVUFBSXBGLE1BQU0sSUFBSWlCLEtBQUosQ0FBVSwrQ0FBVixDQUFWOztBQUNBLFVBQUlWLFFBQUosRUFBYztBQUNaLGVBQU9BLFNBQVNQLEdBQVQsQ0FBUDtBQUNELE9BRkQsTUFFTztBQUNMLGNBQU1BLEdBQU47QUFDRDtBQUNGLEtBdkJDLENBeUJGO0FBQ0E7QUFDQTtBQUNBO0FBRUE7QUFDQTs7O0FBQ0EsUUFBSXVGLE9BQUo7O0FBQ0EsUUFBSWhILFFBQVF3RyxNQUFaLEVBQW9CO0FBQ2xCLFVBQUk7QUFDRixZQUFJUyxTQUFTckMsZ0JBQWdCc0MscUJBQWhCLENBQXNDL0IsUUFBdEMsRUFBZ0RrQixHQUFoRCxDQUFiOztBQUNBVyxrQkFBVUMsT0FBT2xDLEdBQWpCO0FBQ0QsT0FIRCxDQUdFLE9BQU90RCxHQUFQLEVBQVk7QUFDWixZQUFJTyxRQUFKLEVBQWM7QUFDWixpQkFBT0EsU0FBU1AsR0FBVCxDQUFQO0FBQ0QsU0FGRCxNQUVPO0FBQ0wsZ0JBQU1BLEdBQU47QUFDRDtBQUNGO0FBQ0Y7O0FBRUQsUUFBSXpCLFFBQVF3RyxNQUFSLElBQ0EsQ0FBRUssUUFERixJQUVBLENBQUVHLE9BRkYsSUFHQWhILFFBQVFtSCxVQUhSLElBSUEsRUFBR25ILFFBQVFtSCxVQUFSLFlBQThCdEksTUFBTUQsUUFBcEMsSUFDQW9CLFFBQVFvSCxXQURYLENBSkosRUFLNkI7QUFDM0I7QUFDQTtBQUNBO0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUVBQyxtQ0FDRXBFLFVBREYsRUFDYzBELGFBRGQsRUFDNkJDLFFBRDdCLEVBQ3VDNUcsT0FEdkMsRUFFRTtBQUNBO0FBQ0E7QUFDQSxnQkFBVXNILEtBQVYsRUFBaUJsRCxNQUFqQixFQUF5QjtBQUN2QjtBQUNBO0FBQ0E7QUFDQSxZQUFJQSxVQUFVLENBQUVwRSxRQUFRdUgsYUFBeEIsRUFBdUM7QUFDckN2RixtQkFBU3NGLEtBQVQsRUFBZ0JsRCxPQUFPd0IsY0FBdkI7QUFDRCxTQUZELE1BRU87QUFDTDVELG1CQUFTc0YsS0FBVCxFQUFnQmxELE1BQWhCO0FBQ0Q7QUFDRixPQWRIO0FBZ0JELEtBaENELE1BZ0NPO0FBRUwsVUFBSXBFLFFBQVF3RyxNQUFSLElBQWtCLENBQUNRLE9BQW5CLElBQThCaEgsUUFBUW1ILFVBQXRDLElBQW9ETixRQUF4RCxFQUFrRTtBQUNoRSxZQUFJLENBQUNELFNBQVNZLGNBQVQsQ0FBd0IsY0FBeEIsQ0FBTCxFQUE4QztBQUM1Q1osbUJBQVNhLFlBQVQsR0FBd0IsRUFBeEI7QUFDRDs7QUFDRFQsa0JBQVVoSCxRQUFRbUgsVUFBbEI7QUFDQTdHLGVBQU9DLE1BQVAsQ0FBY3FHLFNBQVNhLFlBQXZCLEVBQXFDaEksYUFBYTtBQUFDc0YsZUFBSy9FLFFBQVFtSDtBQUFkLFNBQWIsRUFBd0NoSSwwQkFBeEMsQ0FBckM7QUFDRDs7QUFFRDhELGlCQUFXeUUsTUFBWCxDQUNFZixhQURGLEVBQ2lCQyxRQURqQixFQUMyQkwsU0FEM0IsRUFFRWpDLHdCQUF3QixVQUFVN0MsR0FBVixFQUFlMkMsTUFBZixFQUF1QjtBQUM3QyxZQUFJLENBQUUzQyxHQUFOLEVBQVc7QUFDVCxjQUFJa0csZUFBZWhDLGdCQUFnQnZCLE1BQWhCLENBQW5COztBQUNBLGNBQUl1RCxnQkFBZ0IzSCxRQUFRdUgsYUFBNUIsRUFBMkM7QUFDekM7QUFDQTtBQUNBO0FBQ0EsZ0JBQUl2SCxRQUFRd0csTUFBUixJQUFrQm1CLGFBQWFSLFVBQW5DLEVBQStDO0FBQzdDLGtCQUFJSCxPQUFKLEVBQWE7QUFDWFcsNkJBQWFSLFVBQWIsR0FBMEJILE9BQTFCO0FBQ0QsZUFGRCxNQUVPLElBQUlXLGFBQWFSLFVBQWIsWUFBbUMzSyxRQUFRb0MsUUFBL0MsRUFBeUQ7QUFDOUQrSSw2QkFBYVIsVUFBYixHQUEwQixJQUFJdEksTUFBTUQsUUFBVixDQUFtQitJLGFBQWFSLFVBQWIsQ0FBd0JySSxXQUF4QixFQUFuQixDQUExQjtBQUNEO0FBQ0Y7O0FBRURrRCxxQkFBU1AsR0FBVCxFQUFja0csWUFBZDtBQUNELFdBYkQsTUFhTztBQUNMM0YscUJBQVNQLEdBQVQsRUFBY2tHLGFBQWEvQixjQUEzQjtBQUNEO0FBQ0YsU0FsQkQsTUFrQk87QUFDTDVELG1CQUFTUCxHQUFUO0FBQ0Q7QUFDRixPQXRCRCxDQUZGO0FBeUJEO0FBQ0YsR0FsSEQsQ0FrSEUsT0FBT2lELENBQVAsRUFBVTtBQUNWUixVQUFNSixTQUFOO0FBQ0EsVUFBTVksQ0FBTjtBQUNEO0FBQ0YsQ0EvSkQ7O0FBaUtBLElBQUlpQixrQkFBa0IsVUFBVUQsWUFBVixFQUF3QjtBQUM1QyxNQUFJaUMsZUFBZTtBQUFFL0Isb0JBQWdCO0FBQWxCLEdBQW5COztBQUNBLE1BQUlGLFlBQUosRUFBa0I7QUFDaEIsUUFBSWtDLGNBQWNsQyxhQUFhdEIsTUFBL0IsQ0FEZ0IsQ0FHaEI7QUFDQTtBQUNBOztBQUNBLFFBQUl3RCxZQUFZQyxRQUFoQixFQUEwQjtBQUN4QkYsbUJBQWEvQixjQUFiLElBQStCZ0MsWUFBWUMsUUFBWixDQUFxQkMsTUFBcEQ7O0FBRUEsVUFBSUYsWUFBWUMsUUFBWixDQUFxQkMsTUFBckIsSUFBK0IsQ0FBbkMsRUFBc0M7QUFDcENILHFCQUFhUixVQUFiLEdBQTBCUyxZQUFZQyxRQUFaLENBQXFCLENBQXJCLEVBQXdCOUMsR0FBbEQ7QUFDRDtBQUNGLEtBTkQsTUFNTztBQUNMNEMsbUJBQWEvQixjQUFiLEdBQThCZ0MsWUFBWUcsQ0FBMUM7QUFDRDtBQUNGOztBQUVELFNBQU9KLFlBQVA7QUFDRCxDQXBCRDs7QUF1QkEsSUFBSUssdUJBQXVCLENBQTNCLEMsQ0FFQTs7QUFDQWxJLGdCQUFnQm1JLHNCQUFoQixHQUF5QyxVQUFVeEcsR0FBVixFQUFlO0FBRXREO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsTUFBSTZGLFFBQVE3RixJQUFJeUcsTUFBSixJQUFjekcsSUFBSUEsR0FBOUIsQ0FOc0QsQ0FRdEQ7QUFDQTtBQUNBOztBQUNBLE1BQUk2RixNQUFNYSxPQUFOLENBQWMsaUNBQWQsTUFBcUQsQ0FBckQsSUFDQ2IsTUFBTWEsT0FBTixDQUFjLG1FQUFkLE1BQXVGLENBQUMsQ0FEN0YsRUFDZ0c7QUFDOUYsV0FBTyxJQUFQO0FBQ0Q7O0FBRUQsU0FBTyxLQUFQO0FBQ0QsQ0FqQkQ7O0FBbUJBLElBQUlkLCtCQUErQixVQUFVcEUsVUFBVixFQUFzQmtDLFFBQXRCLEVBQWdDa0IsR0FBaEMsRUFDVXJHLE9BRFYsRUFDbUJnQyxRQURuQixFQUM2QjtBQUM5RDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFFQSxNQUFJbUYsYUFBYW5ILFFBQVFtSCxVQUF6QixDQWQ4RCxDQWN6Qjs7QUFDckMsTUFBSWlCLHFCQUFxQjtBQUN2Qm5ELFVBQU0sSUFEaUI7QUFFdkJ3QixXQUFPekcsUUFBUXlHO0FBRlEsR0FBekI7QUFJQSxNQUFJNEIscUJBQXFCO0FBQ3ZCcEQsVUFBTSxJQURpQjtBQUV2QnVCLFlBQVE7QUFGZSxHQUF6QjtBQUtBLE1BQUk4QixvQkFBb0JoSSxPQUFPQyxNQUFQLENBQ3RCZCxhQUFhO0FBQUNzRixTQUFLb0M7QUFBTixHQUFiLEVBQWdDaEksMEJBQWhDLENBRHNCLEVBRXRCa0gsR0FGc0IsQ0FBeEI7QUFJQSxNQUFJa0MsUUFBUVAsb0JBQVo7O0FBRUEsTUFBSVEsV0FBVyxZQUFZO0FBQ3pCRDs7QUFDQSxRQUFJLENBQUVBLEtBQU4sRUFBYTtBQUNYdkcsZUFBUyxJQUFJVSxLQUFKLENBQVUseUJBQXlCc0Ysb0JBQXpCLEdBQWdELFNBQTFELENBQVQ7QUFDRCxLQUZELE1BRU87QUFDTC9FLGlCQUFXeUUsTUFBWCxDQUFrQnZDLFFBQWxCLEVBQTRCa0IsR0FBNUIsRUFBaUMrQixrQkFBakMsRUFDa0I5RCx3QkFBd0IsVUFBVTdDLEdBQVYsRUFBZTJDLE1BQWYsRUFBdUI7QUFDN0MsWUFBSTNDLEdBQUosRUFBUztBQUNQTyxtQkFBU1AsR0FBVDtBQUNELFNBRkQsTUFFTyxJQUFJMkMsVUFBVUEsT0FBT0EsTUFBUCxDQUFjMkQsQ0FBZCxJQUFtQixDQUFqQyxFQUFvQztBQUN6Qy9GLG1CQUFTLElBQVQsRUFBZTtBQUNiNEQsNEJBQWdCeEIsT0FBT0EsTUFBUCxDQUFjMkQ7QUFEakIsV0FBZjtBQUdELFNBSk0sTUFJQTtBQUNMVTtBQUNEO0FBQ0YsT0FWRCxDQURsQjtBQVlEO0FBQ0YsR0FsQkQ7O0FBb0JBLE1BQUlBLHNCQUFzQixZQUFZO0FBQ3BDeEYsZUFBV3lFLE1BQVgsQ0FBa0J2QyxRQUFsQixFQUE0Qm1ELGlCQUE1QixFQUErQ0Qsa0JBQS9DLEVBQ2tCL0Qsd0JBQXdCLFVBQVU3QyxHQUFWLEVBQWUyQyxNQUFmLEVBQXVCO0FBQzdDLFVBQUkzQyxHQUFKLEVBQVM7QUFDUDtBQUNBO0FBQ0E7QUFDQSxZQUFJM0IsZ0JBQWdCbUksc0JBQWhCLENBQXVDeEcsR0FBdkMsQ0FBSixFQUFpRDtBQUMvQytHO0FBQ0QsU0FGRCxNQUVPO0FBQ0x4RyxtQkFBU1AsR0FBVDtBQUNEO0FBQ0YsT0FURCxNQVNPO0FBQ0xPLGlCQUFTLElBQVQsRUFBZTtBQUNiNEQsMEJBQWdCeEIsT0FBT0EsTUFBUCxDQUFjeUQsUUFBZCxDQUF1QkMsTUFEMUI7QUFFYlgsc0JBQVlBO0FBRkMsU0FBZjtBQUlEO0FBQ0YsS0FoQkQsQ0FEbEI7QUFrQkQsR0FuQkQ7O0FBcUJBcUI7QUFDRCxDQXpFRDs7QUEyRUFoTCxFQUFFSyxJQUFGLENBQU8sQ0FBQyxRQUFELEVBQVcsUUFBWCxFQUFxQixRQUFyQixFQUErQixnQkFBL0IsRUFBaUQsY0FBakQsQ0FBUCxFQUF5RSxVQUFVNkssTUFBVixFQUFrQjtBQUN6RjVJLGtCQUFnQjdCLFNBQWhCLENBQTBCeUssTUFBMUIsSUFBb0M7QUFBVTtBQUFpQjtBQUM3RCxRQUFJekksT0FBTyxJQUFYO0FBQ0EsV0FBT3NCLE9BQU9vSCxTQUFQLENBQWlCMUksS0FBSyxNQUFNeUksTUFBWCxDQUFqQixFQUFxQ0UsS0FBckMsQ0FBMkMzSSxJQUEzQyxFQUFpRDRJLFNBQWpELENBQVA7QUFDRCxHQUhEO0FBSUQsQ0FMRCxFLENBT0E7QUFDQTtBQUNBOzs7QUFDQS9JLGdCQUFnQjdCLFNBQWhCLENBQTBCdUksTUFBMUIsR0FBbUMsVUFBVXpELGNBQVYsRUFBMEJvQyxRQUExQixFQUFvQ2tCLEdBQXBDLEVBQ1VyRyxPQURWLEVBQ21CZ0MsUUFEbkIsRUFDNkI7QUFDOUQsTUFBSS9CLE9BQU8sSUFBWDs7QUFDQSxNQUFJLE9BQU9ELE9BQVAsS0FBbUIsVUFBbkIsSUFBaUMsQ0FBRWdDLFFBQXZDLEVBQWlEO0FBQy9DQSxlQUFXaEMsT0FBWDtBQUNBQSxjQUFVLEVBQVY7QUFDRDs7QUFFRCxTQUFPQyxLQUFLeUgsTUFBTCxDQUFZM0UsY0FBWixFQUE0Qm9DLFFBQTVCLEVBQXNDa0IsR0FBdEMsRUFDWTdJLEVBQUUrSCxNQUFGLENBQVMsRUFBVCxFQUFhdkYsT0FBYixFQUFzQjtBQUNwQndHLFlBQVEsSUFEWTtBQUVwQmUsbUJBQWU7QUFGSyxHQUF0QixDQURaLEVBSWdCdkYsUUFKaEIsQ0FBUDtBQUtELENBYkQ7O0FBZUFsQyxnQkFBZ0I3QixTQUFoQixDQUEwQjZLLElBQTFCLEdBQWlDLFVBQVUvRixjQUFWLEVBQTBCb0MsUUFBMUIsRUFBb0NuRixPQUFwQyxFQUE2QztBQUM1RSxNQUFJQyxPQUFPLElBQVg7QUFFQSxNQUFJNEksVUFBVWYsTUFBVixLQUFxQixDQUF6QixFQUNFM0MsV0FBVyxFQUFYO0FBRUYsU0FBTyxJQUFJNEQsTUFBSixDQUNMOUksSUFESyxFQUNDLElBQUkrSSxpQkFBSixDQUFzQmpHLGNBQXRCLEVBQXNDb0MsUUFBdEMsRUFBZ0RuRixPQUFoRCxDQURELENBQVA7QUFFRCxDQVJEOztBQVVBRixnQkFBZ0I3QixTQUFoQixDQUEwQmdMLE9BQTFCLEdBQW9DLFVBQVV6RSxlQUFWLEVBQTJCVyxRQUEzQixFQUNVbkYsT0FEVixFQUNtQjtBQUNyRCxNQUFJQyxPQUFPLElBQVg7QUFDQSxNQUFJNEksVUFBVWYsTUFBVixLQUFxQixDQUF6QixFQUNFM0MsV0FBVyxFQUFYO0FBRUZuRixZQUFVQSxXQUFXLEVBQXJCO0FBQ0FBLFVBQVFrSixLQUFSLEdBQWdCLENBQWhCO0FBQ0EsU0FBT2pKLEtBQUs2SSxJQUFMLENBQVV0RSxlQUFWLEVBQTJCVyxRQUEzQixFQUFxQ25GLE9BQXJDLEVBQThDbUosS0FBOUMsR0FBc0QsQ0FBdEQsQ0FBUDtBQUNELENBVEQsQyxDQVdBO0FBQ0E7OztBQUNBckosZ0JBQWdCN0IsU0FBaEIsQ0FBMEJtTCxZQUExQixHQUF5QyxVQUFVckcsY0FBVixFQUEwQnNHLEtBQTFCLEVBQ1VySixPQURWLEVBQ21CO0FBQzFELE1BQUlDLE9BQU8sSUFBWCxDQUQwRCxDQUcxRDtBQUNBOztBQUNBLE1BQUlnRCxhQUFhaEQsS0FBSzZDLGFBQUwsQ0FBbUJDLGNBQW5CLENBQWpCO0FBQ0EsTUFBSUMsU0FBUyxJQUFJdEcsTUFBSixFQUFiO0FBQ0EsTUFBSTRNLFlBQVlyRyxXQUFXc0csV0FBWCxDQUF1QkYsS0FBdkIsRUFBOEJySixPQUE5QixFQUF1Q2dELE9BQU9kLFFBQVAsRUFBdkMsQ0FBaEI7QUFDQWMsU0FBT2IsSUFBUDtBQUNELENBVkQ7O0FBV0FyQyxnQkFBZ0I3QixTQUFoQixDQUEwQnVMLFVBQTFCLEdBQXVDLFVBQVV6RyxjQUFWLEVBQTBCc0csS0FBMUIsRUFBaUM7QUFDdEUsTUFBSXBKLE9BQU8sSUFBWCxDQURzRSxDQUd0RTtBQUNBOztBQUNBLE1BQUlnRCxhQUFhaEQsS0FBSzZDLGFBQUwsQ0FBbUJDLGNBQW5CLENBQWpCO0FBQ0EsTUFBSUMsU0FBUyxJQUFJdEcsTUFBSixFQUFiO0FBQ0EsTUFBSTRNLFlBQVlyRyxXQUFXd0csU0FBWCxDQUFxQkosS0FBckIsRUFBNEJyRyxPQUFPZCxRQUFQLEVBQTVCLENBQWhCO0FBQ0FjLFNBQU9iLElBQVA7QUFDRCxDQVRELEMsQ0FXQTtBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBRUE2RyxvQkFBb0IsVUFBVWpHLGNBQVYsRUFBMEJvQyxRQUExQixFQUFvQ25GLE9BQXBDLEVBQTZDO0FBQy9ELE1BQUlDLE9BQU8sSUFBWDtBQUNBQSxPQUFLOEMsY0FBTCxHQUFzQkEsY0FBdEI7QUFDQTlDLE9BQUtrRixRQUFMLEdBQWdCdEcsTUFBTTZLLFVBQU4sQ0FBaUJDLGdCQUFqQixDQUFrQ3hFLFFBQWxDLENBQWhCO0FBQ0FsRixPQUFLRCxPQUFMLEdBQWVBLFdBQVcsRUFBMUI7QUFDRCxDQUxEOztBQU9BK0ksU0FBUyxVQUFVYSxLQUFWLEVBQWlCQyxpQkFBakIsRUFBb0M7QUFDM0MsTUFBSTVKLE9BQU8sSUFBWDtBQUVBQSxPQUFLNkosTUFBTCxHQUFjRixLQUFkO0FBQ0EzSixPQUFLOEosa0JBQUwsR0FBMEJGLGlCQUExQjtBQUNBNUosT0FBSytKLGtCQUFMLEdBQTBCLElBQTFCO0FBQ0QsQ0FORDs7QUFRQXhNLEVBQUVLLElBQUYsQ0FBTyxDQUFDLFNBQUQsRUFBWSxLQUFaLEVBQW1CLE9BQW5CLEVBQTRCLE9BQTVCLENBQVAsRUFBNkMsVUFBVTZLLE1BQVYsRUFBa0I7QUFDN0RLLFNBQU85SyxTQUFQLENBQWlCeUssTUFBakIsSUFBMkIsWUFBWTtBQUNyQyxRQUFJekksT0FBTyxJQUFYLENBRHFDLENBR3JDOztBQUNBLFFBQUlBLEtBQUs4SixrQkFBTCxDQUF3Qi9KLE9BQXhCLENBQWdDaUssUUFBcEMsRUFDRSxNQUFNLElBQUl2SCxLQUFKLENBQVUsaUJBQWlCZ0csTUFBakIsR0FBMEIsdUJBQXBDLENBQU47O0FBRUYsUUFBSSxDQUFDekksS0FBSytKLGtCQUFWLEVBQThCO0FBQzVCL0osV0FBSytKLGtCQUFMLEdBQTBCL0osS0FBSzZKLE1BQUwsQ0FBWUksd0JBQVosQ0FDeEJqSyxLQUFLOEosa0JBRG1CLEVBQ0M7QUFDdkI7QUFDQTtBQUNBSSwwQkFBa0JsSyxJQUhLO0FBSXZCbUssc0JBQWM7QUFKUyxPQURELENBQTFCO0FBT0Q7O0FBRUQsV0FBT25LLEtBQUsrSixrQkFBTCxDQUF3QnRCLE1BQXhCLEVBQWdDRSxLQUFoQyxDQUNMM0ksS0FBSytKLGtCQURBLEVBQ29CbkIsU0FEcEIsQ0FBUDtBQUVELEdBbkJEO0FBb0JELENBckJELEUsQ0F1QkE7QUFDQTtBQUNBO0FBQ0E7OztBQUNBRSxPQUFPOUssU0FBUCxDQUFpQm9NLE1BQWpCLEdBQTBCLFlBQVksQ0FDckMsQ0FERDs7QUFHQXRCLE9BQU85SyxTQUFQLENBQWlCcU0sWUFBakIsR0FBZ0MsWUFBWTtBQUMxQyxTQUFPLEtBQUtQLGtCQUFMLENBQXdCL0osT0FBeEIsQ0FBZ0N1SyxTQUF2QztBQUNELENBRkQsQyxDQUlBO0FBQ0E7QUFDQTs7O0FBRUF4QixPQUFPOUssU0FBUCxDQUFpQnVNLGNBQWpCLEdBQWtDLFVBQVVDLEdBQVYsRUFBZTtBQUMvQyxNQUFJeEssT0FBTyxJQUFYO0FBQ0EsTUFBSWdELGFBQWFoRCxLQUFLOEosa0JBQUwsQ0FBd0JoSCxjQUF6QztBQUNBLFNBQU9sRSxNQUFNNkssVUFBTixDQUFpQmMsY0FBakIsQ0FBZ0N2SyxJQUFoQyxFQUFzQ3dLLEdBQXRDLEVBQTJDeEgsVUFBM0MsQ0FBUDtBQUNELENBSkQsQyxDQU1BO0FBQ0E7QUFDQTs7O0FBQ0E4RixPQUFPOUssU0FBUCxDQUFpQnlNLGtCQUFqQixHQUFzQyxZQUFZO0FBQ2hELE1BQUl6SyxPQUFPLElBQVg7QUFDQSxTQUFPQSxLQUFLOEosa0JBQUwsQ0FBd0JoSCxjQUEvQjtBQUNELENBSEQ7O0FBS0FnRyxPQUFPOUssU0FBUCxDQUFpQjBNLE9BQWpCLEdBQTJCLFVBQVVDLFNBQVYsRUFBcUI7QUFDOUMsTUFBSTNLLE9BQU8sSUFBWDtBQUNBLFNBQU8yRSxnQkFBZ0JpRywwQkFBaEIsQ0FBMkM1SyxJQUEzQyxFQUFpRDJLLFNBQWpELENBQVA7QUFDRCxDQUhEOztBQUtBN0IsT0FBTzlLLFNBQVAsQ0FBaUI2TSxjQUFqQixHQUFrQyxVQUFVRixTQUFWLEVBQXFCO0FBQ3JELE1BQUkzSyxPQUFPLElBQVg7QUFDQSxNQUFJOEssVUFBVSxDQUNaLFNBRFksRUFFWixPQUZZLEVBR1osV0FIWSxFQUlaLFNBSlksRUFLWixXQUxZLEVBTVosU0FOWSxFQU9aLFNBUFksQ0FBZDs7QUFTQSxNQUFJQyxVQUFVcEcsZ0JBQWdCcUcsa0NBQWhCLENBQW1ETCxTQUFuRCxDQUFkLENBWHFELENBYXJEOzs7QUFDQSxNQUFJTSxnQkFBZ0Isa0NBQXBCO0FBQ0FILFVBQVFJLE9BQVIsQ0FBZ0IsVUFBVXpDLE1BQVYsRUFBa0I7QUFDaEMsUUFBSWtDLFVBQVVsQyxNQUFWLEtBQXFCLE9BQU9rQyxVQUFVbEMsTUFBVixDQUFQLElBQTRCLFVBQXJELEVBQWlFO0FBQy9Ea0MsZ0JBQVVsQyxNQUFWLElBQW9CbkgsT0FBT0MsZUFBUCxDQUF1Qm9KLFVBQVVsQyxNQUFWLENBQXZCLEVBQTBDQSxTQUFTd0MsYUFBbkQsQ0FBcEI7QUFDRDtBQUNGLEdBSkQ7QUFNQSxTQUFPakwsS0FBSzZKLE1BQUwsQ0FBWXNCLGVBQVosQ0FDTG5MLEtBQUs4SixrQkFEQSxFQUNvQmlCLE9BRHBCLEVBQzZCSixTQUQ3QixDQUFQO0FBRUQsQ0F2QkQ7O0FBeUJBOUssZ0JBQWdCN0IsU0FBaEIsQ0FBMEJpTSx3QkFBMUIsR0FBcUQsVUFDakRMLGlCQURpRCxFQUM5QjdKLE9BRDhCLEVBQ3JCO0FBQzlCLE1BQUlDLE9BQU8sSUFBWDtBQUNBRCxZQUFVeEMsRUFBRTZOLElBQUYsQ0FBT3JMLFdBQVcsRUFBbEIsRUFBc0Isa0JBQXRCLEVBQTBDLGNBQTFDLENBQVY7QUFFQSxNQUFJaUQsYUFBYWhELEtBQUs2QyxhQUFMLENBQW1CK0csa0JBQWtCOUcsY0FBckMsQ0FBakI7QUFDQSxNQUFJdUksZ0JBQWdCekIsa0JBQWtCN0osT0FBdEM7QUFDQSxNQUFJSyxlQUFlO0FBQ2pCa0wsVUFBTUQsY0FBY0MsSUFESDtBQUVqQnJDLFdBQU9vQyxjQUFjcEMsS0FGSjtBQUdqQnNDLFVBQU1GLGNBQWNFO0FBSEgsR0FBbkIsQ0FOOEIsQ0FZOUI7O0FBQ0EsTUFBSUYsY0FBY3JCLFFBQWxCLEVBQTRCO0FBQzFCO0FBQ0E1SixpQkFBYTRKLFFBQWIsR0FBd0IsSUFBeEIsQ0FGMEIsQ0FHMUI7QUFDQTs7QUFDQTVKLGlCQUFhb0wsU0FBYixHQUF5QixJQUF6QixDQUwwQixDQU0xQjtBQUNBOztBQUNBcEwsaUJBQWFxTCxlQUFiLEdBQStCLENBQUMsQ0FBaEMsQ0FSMEIsQ0FTMUI7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxRQUFJN0Isa0JBQWtCOUcsY0FBbEIsS0FBcUM0SSxnQkFBckMsSUFDQTlCLGtCQUFrQjFFLFFBQWxCLENBQTJCeUcsRUFEL0IsRUFDbUM7QUFDakN2TCxtQkFBYXdMLFdBQWIsR0FBMkIsSUFBM0I7QUFDRDtBQUNGOztBQUVELE1BQUlDLFdBQVc3SSxXQUFXNkYsSUFBWCxDQUNickosYUFBYW9LLGtCQUFrQjFFLFFBQS9CLEVBQXlDaEcsMEJBQXpDLENBRGEsRUFFYm1NLGNBQWNTLE1BRkQsRUFFUzFMLFlBRlQsQ0FBZjs7QUFJQSxNQUFJLE9BQU9pTCxjQUFjVSxTQUFyQixLQUFtQyxXQUF2QyxFQUFvRDtBQUNsREYsZUFBV0EsU0FBU0csU0FBVCxDQUFtQlgsY0FBY1UsU0FBakMsQ0FBWDtBQUNEOztBQUNELE1BQUksT0FBT1YsY0FBY1ksSUFBckIsS0FBOEIsV0FBbEMsRUFBK0M7QUFDN0NKLGVBQVdBLFNBQVNJLElBQVQsQ0FBY1osY0FBY1ksSUFBNUIsQ0FBWDtBQUNEOztBQUVELFNBQU8sSUFBSUMsaUJBQUosQ0FBc0JMLFFBQXRCLEVBQWdDakMsaUJBQWhDLEVBQW1EN0osT0FBbkQsQ0FBUDtBQUNELENBOUNEOztBQWdEQSxJQUFJbU0sb0JBQW9CLFVBQVVMLFFBQVYsRUFBb0JqQyxpQkFBcEIsRUFBdUM3SixPQUF2QyxFQUFnRDtBQUN0RSxNQUFJQyxPQUFPLElBQVg7QUFDQUQsWUFBVXhDLEVBQUU2TixJQUFGLENBQU9yTCxXQUFXLEVBQWxCLEVBQXNCLGtCQUF0QixFQUEwQyxjQUExQyxDQUFWO0FBRUFDLE9BQUttTSxTQUFMLEdBQWlCTixRQUFqQjtBQUNBN0wsT0FBSzhKLGtCQUFMLEdBQTBCRixpQkFBMUIsQ0FMc0UsQ0FNdEU7QUFDQTs7QUFDQTVKLE9BQUtvTSxpQkFBTCxHQUF5QnJNLFFBQVFtSyxnQkFBUixJQUE0QmxLLElBQXJEOztBQUNBLE1BQUlELFFBQVFvSyxZQUFSLElBQXdCUCxrQkFBa0I3SixPQUFsQixDQUEwQnVLLFNBQXRELEVBQWlFO0FBQy9EdEssU0FBS3FNLFVBQUwsR0FBa0IxSCxnQkFBZ0IySCxhQUFoQixDQUNoQjFDLGtCQUFrQjdKLE9BQWxCLENBQTBCdUssU0FEVixDQUFsQjtBQUVELEdBSEQsTUFHTztBQUNMdEssU0FBS3FNLFVBQUwsR0FBa0IsSUFBbEI7QUFDRCxHQWRxRSxDQWdCdEU7QUFDQTtBQUNBOzs7QUFDQXJNLE9BQUt1TSxzQkFBTCxHQUE4QjlQLE9BQU9tRyxJQUFQLENBQzVCaUosU0FBU1csVUFBVCxDQUFvQjlPLElBQXBCLENBQXlCbU8sUUFBekIsQ0FENEIsRUFDUSxDQURSLENBQTlCO0FBRUE3TCxPQUFLeU0saUJBQUwsR0FBeUJoUSxPQUFPbUcsSUFBUCxDQUFZaUosU0FBU2EsS0FBVCxDQUFlaFAsSUFBZixDQUFvQm1PLFFBQXBCLENBQVosQ0FBekI7QUFDQTdMLE9BQUsyTSxXQUFMLEdBQW1CLElBQUloSSxnQkFBZ0JpSSxNQUFwQixFQUFuQjtBQUNELENBdkJEOztBQXlCQXJQLEVBQUUrSCxNQUFGLENBQVM0RyxrQkFBa0JsTyxTQUEzQixFQUFzQztBQUNwQzZPLGVBQWEsWUFBWTtBQUN2QixRQUFJN00sT0FBTyxJQUFYOztBQUVBLFdBQU8sSUFBUCxFQUFhO0FBQ1gsVUFBSThCLE1BQU05QixLQUFLdU0sc0JBQUwsR0FBOEJySyxJQUE5QixFQUFWOztBQUVBLFVBQUksQ0FBQ0osR0FBTCxFQUFVLE9BQU8sSUFBUDtBQUNWQSxZQUFNdEMsYUFBYXNDLEdBQWIsRUFBa0J4RCwwQkFBbEIsQ0FBTjs7QUFFQSxVQUFJLENBQUMwQixLQUFLOEosa0JBQUwsQ0FBd0IvSixPQUF4QixDQUFnQ2lLLFFBQWpDLElBQTZDek0sRUFBRXVELEdBQUYsQ0FBTWdCLEdBQU4sRUFBVyxLQUFYLENBQWpELEVBQW9FO0FBQ2xFO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFlBQUk5QixLQUFLMk0sV0FBTCxDQUFpQjdMLEdBQWpCLENBQXFCZ0IsSUFBSWdELEdBQXpCLENBQUosRUFBbUM7O0FBQ25DOUUsYUFBSzJNLFdBQUwsQ0FBaUJHLEdBQWpCLENBQXFCaEwsSUFBSWdELEdBQXpCLEVBQThCLElBQTlCO0FBQ0Q7O0FBRUQsVUFBSTlFLEtBQUtxTSxVQUFULEVBQ0V2SyxNQUFNOUIsS0FBS3FNLFVBQUwsQ0FBZ0J2SyxHQUFoQixDQUFOO0FBRUYsYUFBT0EsR0FBUDtBQUNEO0FBQ0YsR0ExQm1DO0FBNEJwQ29KLFdBQVMsVUFBVW5KLFFBQVYsRUFBb0JnTCxPQUFwQixFQUE2QjtBQUNwQyxRQUFJL00sT0FBTyxJQUFYLENBRG9DLENBR3BDOztBQUNBQSxTQUFLZ04sT0FBTCxHQUpvQyxDQU1wQztBQUNBO0FBQ0E7OztBQUNBLFFBQUk1RCxRQUFRLENBQVo7O0FBQ0EsV0FBTyxJQUFQLEVBQWE7QUFDWCxVQUFJdEgsTUFBTTlCLEtBQUs2TSxXQUFMLEVBQVY7O0FBQ0EsVUFBSSxDQUFDL0ssR0FBTCxFQUFVO0FBQ1ZDLGVBQVNrTCxJQUFULENBQWNGLE9BQWQsRUFBdUJqTCxHQUF2QixFQUE0QnNILE9BQTVCLEVBQXFDcEosS0FBS29NLGlCQUExQztBQUNEO0FBQ0YsR0EzQ21DO0FBNkNwQztBQUNBM08sT0FBSyxVQUFVc0UsUUFBVixFQUFvQmdMLE9BQXBCLEVBQTZCO0FBQ2hDLFFBQUkvTSxPQUFPLElBQVg7QUFDQSxRQUFJa04sTUFBTSxFQUFWO0FBQ0FsTixTQUFLa0wsT0FBTCxDQUFhLFVBQVVwSixHQUFWLEVBQWVzSCxLQUFmLEVBQXNCO0FBQ2pDOEQsVUFBSUMsSUFBSixDQUFTcEwsU0FBU2tMLElBQVQsQ0FBY0YsT0FBZCxFQUF1QmpMLEdBQXZCLEVBQTRCc0gsS0FBNUIsRUFBbUNwSixLQUFLb00saUJBQXhDLENBQVQ7QUFDRCxLQUZEO0FBR0EsV0FBT2MsR0FBUDtBQUNELEdBckRtQztBQXVEcENGLFdBQVMsWUFBWTtBQUNuQixRQUFJaE4sT0FBTyxJQUFYLENBRG1CLENBR25COztBQUNBQSxTQUFLbU0sU0FBTCxDQUFlL0IsTUFBZjs7QUFFQXBLLFNBQUsyTSxXQUFMLEdBQW1CLElBQUloSSxnQkFBZ0JpSSxNQUFwQixFQUFuQjtBQUNELEdBOURtQztBQWdFcEM7QUFDQXBLLFNBQU8sWUFBWTtBQUNqQixRQUFJeEMsT0FBTyxJQUFYOztBQUVBQSxTQUFLbU0sU0FBTCxDQUFlM0osS0FBZjtBQUNELEdBckVtQztBQXVFcEMwRyxTQUFPLFlBQVk7QUFDakIsUUFBSWxKLE9BQU8sSUFBWDtBQUNBLFdBQU9BLEtBQUt2QyxHQUFMLENBQVNGLEVBQUU2UCxRQUFYLENBQVA7QUFDRCxHQTFFbUM7QUE0RXBDVixTQUFPLFVBQVVXLGlCQUFpQixLQUEzQixFQUFrQztBQUN2QyxRQUFJck4sT0FBTyxJQUFYO0FBQ0EsV0FBT0EsS0FBS3lNLGlCQUFMLENBQXVCWSxjQUF2QixFQUF1Q25MLElBQXZDLEVBQVA7QUFDRCxHQS9FbUM7QUFpRnBDO0FBQ0FvTCxpQkFBZSxVQUFVdkMsT0FBVixFQUFtQjtBQUNoQyxRQUFJL0ssT0FBTyxJQUFYOztBQUNBLFFBQUkrSyxPQUFKLEVBQWE7QUFDWCxhQUFPL0ssS0FBS2tKLEtBQUwsRUFBUDtBQUNELEtBRkQsTUFFTztBQUNMLFVBQUlxRSxVQUFVLElBQUk1SSxnQkFBZ0JpSSxNQUFwQixFQUFkO0FBQ0E1TSxXQUFLa0wsT0FBTCxDQUFhLFVBQVVwSixHQUFWLEVBQWU7QUFDMUJ5TCxnQkFBUVQsR0FBUixDQUFZaEwsSUFBSWdELEdBQWhCLEVBQXFCaEQsR0FBckI7QUFDRCxPQUZEO0FBR0EsYUFBT3lMLE9BQVA7QUFDRDtBQUNGO0FBN0ZtQyxDQUF0Qzs7QUFnR0ExTixnQkFBZ0I3QixTQUFoQixDQUEwQndQLElBQTFCLEdBQWlDLFVBQVU1RCxpQkFBVixFQUE2QjZELFdBQTdCLEVBQTBDO0FBQ3pFLE1BQUl6TixPQUFPLElBQVg7QUFDQSxNQUFJLENBQUM0SixrQkFBa0I3SixPQUFsQixDQUEwQmlLLFFBQS9CLEVBQ0UsTUFBTSxJQUFJdkgsS0FBSixDQUFVLGlDQUFWLENBQU47O0FBRUYsTUFBSWlMLFNBQVMxTixLQUFLaUssd0JBQUwsQ0FBOEJMLGlCQUE5QixDQUFiOztBQUVBLE1BQUkrRCxVQUFVLEtBQWQ7QUFDQSxNQUFJQyxNQUFKOztBQUNBLE1BQUlDLE9BQU8sWUFBWTtBQUNyQixRQUFJL0wsTUFBTSxJQUFWOztBQUNBLFdBQU8sSUFBUCxFQUFhO0FBQ1gsVUFBSTZMLE9BQUosRUFDRTs7QUFDRixVQUFJO0FBQ0Y3TCxjQUFNNEwsT0FBT2IsV0FBUCxFQUFOO0FBQ0QsT0FGRCxDQUVFLE9BQU9yTCxHQUFQLEVBQVk7QUFDWjtBQUNBO0FBQ0E7QUFDQU0sY0FBTSxJQUFOO0FBQ0QsT0FWVSxDQVdYO0FBQ0E7OztBQUNBLFVBQUk2TCxPQUFKLEVBQ0U7O0FBQ0YsVUFBSTdMLEdBQUosRUFBUztBQUNQO0FBQ0E7QUFDQTtBQUNBO0FBQ0E4TCxpQkFBUzlMLElBQUk2SixFQUFiO0FBQ0E4QixvQkFBWTNMLEdBQVo7QUFDRCxPQVBELE1BT087QUFDTCxZQUFJZ00sY0FBY3ZRLEVBQUVVLEtBQUYsQ0FBUTJMLGtCQUFrQjFFLFFBQTFCLENBQWxCOztBQUNBLFlBQUkwSSxNQUFKLEVBQVk7QUFDVkUsc0JBQVluQyxFQUFaLEdBQWlCO0FBQUNvQyxpQkFBS0g7QUFBTixXQUFqQjtBQUNEOztBQUNERixpQkFBUzFOLEtBQUtpSyx3QkFBTCxDQUE4QixJQUFJbEIsaUJBQUosQ0FDckNhLGtCQUFrQjlHLGNBRG1CLEVBRXJDZ0wsV0FGcUMsRUFHckNsRSxrQkFBa0I3SixPQUhtQixDQUE5QixDQUFULENBTEssQ0FTTDtBQUNBO0FBQ0E7O0FBQ0F1QixlQUFPME0sVUFBUCxDQUFrQkgsSUFBbEIsRUFBd0IsR0FBeEI7QUFDQTtBQUNEO0FBQ0Y7QUFDRixHQXhDRDs7QUEwQ0F2TSxTQUFPMk0sS0FBUCxDQUFhSixJQUFiO0FBRUEsU0FBTztBQUNMbEwsVUFBTSxZQUFZO0FBQ2hCZ0wsZ0JBQVUsSUFBVjtBQUNBRCxhQUFPbEwsS0FBUDtBQUNEO0FBSkksR0FBUDtBQU1ELENBM0REOztBQTZEQTNDLGdCQUFnQjdCLFNBQWhCLENBQTBCbU4sZUFBMUIsR0FBNEMsVUFDeEN2QixpQkFEd0MsRUFDckJtQixPQURxQixFQUNaSixTQURZLEVBQ0Q7QUFDekMsTUFBSTNLLE9BQU8sSUFBWDs7QUFFQSxNQUFJNEosa0JBQWtCN0osT0FBbEIsQ0FBMEJpSyxRQUE5QixFQUF3QztBQUN0QyxXQUFPaEssS0FBS2tPLHVCQUFMLENBQTZCdEUsaUJBQTdCLEVBQWdEbUIsT0FBaEQsRUFBeURKLFNBQXpELENBQVA7QUFDRCxHQUx3QyxDQU96QztBQUNBOzs7QUFDQSxNQUFJZixrQkFBa0I3SixPQUFsQixDQUEwQitMLE1BQTFCLEtBQ0NsQyxrQkFBa0I3SixPQUFsQixDQUEwQitMLE1BQTFCLENBQWlDaEgsR0FBakMsS0FBeUMsQ0FBekMsSUFDQThFLGtCQUFrQjdKLE9BQWxCLENBQTBCK0wsTUFBMUIsQ0FBaUNoSCxHQUFqQyxLQUF5QyxLQUYxQyxDQUFKLEVBRXNEO0FBQ3BELFVBQU1yQyxNQUFNLHNEQUFOLENBQU47QUFDRDs7QUFFRCxNQUFJMEwsYUFBYXBQLE1BQU1xUCxTQUFOLENBQ2Y3USxFQUFFK0gsTUFBRixDQUFTO0FBQUN5RixhQUFTQTtBQUFWLEdBQVQsRUFBNkJuQixpQkFBN0IsQ0FEZSxDQUFqQjtBQUdBLE1BQUl5RSxXQUFKLEVBQWlCQyxhQUFqQjtBQUNBLE1BQUlDLGNBQWMsS0FBbEIsQ0FuQnlDLENBcUJ6QztBQUNBO0FBQ0E7O0FBQ0FqTixTQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxRQUFJalIsRUFBRXVELEdBQUYsQ0FBTWQsS0FBS0Msb0JBQVgsRUFBaUNrTyxVQUFqQyxDQUFKLEVBQWtEO0FBQ2hERSxvQkFBY3JPLEtBQUtDLG9CQUFMLENBQTBCa08sVUFBMUIsQ0FBZDtBQUNELEtBRkQsTUFFTztBQUNMSSxvQkFBYyxJQUFkLENBREssQ0FFTDs7QUFDQUYsb0JBQWMsSUFBSUksa0JBQUosQ0FBdUI7QUFDbkMxRCxpQkFBU0EsT0FEMEI7QUFFbkMyRCxnQkFBUSxZQUFZO0FBQ2xCLGlCQUFPMU8sS0FBS0Msb0JBQUwsQ0FBMEJrTyxVQUExQixDQUFQO0FBQ0FHLHdCQUFjM0wsSUFBZDtBQUNEO0FBTGtDLE9BQXZCLENBQWQ7QUFPQTNDLFdBQUtDLG9CQUFMLENBQTBCa08sVUFBMUIsSUFBd0NFLFdBQXhDO0FBQ0Q7QUFDRixHQWZEOztBQWlCQSxNQUFJTSxnQkFBZ0IsSUFBSUMsYUFBSixDQUFrQlAsV0FBbEIsRUFBK0IxRCxTQUEvQixDQUFwQjs7QUFFQSxNQUFJNEQsV0FBSixFQUFpQjtBQUNmLFFBQUlNLE9BQUosRUFBYUMsTUFBYjs7QUFDQSxRQUFJQyxjQUFjeFIsRUFBRXlSLEdBQUYsQ0FBTSxDQUN0QixZQUFZO0FBQ1Y7QUFDQTtBQUNBO0FBQ0EsYUFBT2hQLEtBQUtrQixZQUFMLElBQXFCLENBQUM2SixPQUF0QixJQUNMLENBQUNKLFVBQVVzRSxxQkFEYjtBQUVELEtBUHFCLEVBT25CLFlBQVk7QUFDYjtBQUNBO0FBQ0EsVUFBSTtBQUNGSixrQkFBVSxJQUFJSyxVQUFVQyxPQUFkLENBQXNCdkYsa0JBQWtCMUUsUUFBeEMsQ0FBVjtBQUNBLGVBQU8sSUFBUDtBQUNELE9BSEQsQ0FHRSxPQUFPVCxDQUFQLEVBQVU7QUFDVjtBQUNBO0FBQ0EsZUFBTyxLQUFQO0FBQ0Q7QUFDRixLQWxCcUIsRUFrQm5CLFlBQVk7QUFDYjtBQUNBLGFBQU8ySyxtQkFBbUJDLGVBQW5CLENBQW1DekYsaUJBQW5DLEVBQXNEaUYsT0FBdEQsQ0FBUDtBQUNELEtBckJxQixFQXFCbkIsWUFBWTtBQUNiO0FBQ0E7QUFDQSxVQUFJLENBQUNqRixrQkFBa0I3SixPQUFsQixDQUEwQnVMLElBQS9CLEVBQ0UsT0FBTyxJQUFQOztBQUNGLFVBQUk7QUFDRndELGlCQUFTLElBQUlJLFVBQVVJLE1BQWQsQ0FBcUIxRixrQkFBa0I3SixPQUFsQixDQUEwQnVMLElBQS9DLEVBQ3FCO0FBQUV1RCxtQkFBU0E7QUFBWCxTQURyQixDQUFUO0FBRUEsZUFBTyxJQUFQO0FBQ0QsT0FKRCxDQUlFLE9BQU9wSyxDQUFQLEVBQVU7QUFDVjtBQUNBO0FBQ0EsZUFBTyxLQUFQO0FBQ0Q7QUFDRixLQW5DcUIsQ0FBTixFQW1DWixVQUFVOEssQ0FBVixFQUFhO0FBQUUsYUFBT0EsR0FBUDtBQUFhLEtBbkNoQixDQUFsQixDQUZlLENBcUN1Qjs7O0FBRXRDLFFBQUlDLGNBQWNULGNBQWNLLGtCQUFkLEdBQW1DSyxvQkFBckQ7QUFDQW5CLG9CQUFnQixJQUFJa0IsV0FBSixDQUFnQjtBQUM5QjVGLHlCQUFtQkEsaUJBRFc7QUFFOUI4RixtQkFBYTFQLElBRmlCO0FBRzlCcU8sbUJBQWFBLFdBSGlCO0FBSTlCdEQsZUFBU0EsT0FKcUI7QUFLOUI4RCxlQUFTQSxPQUxxQjtBQUtYO0FBQ25CQyxjQUFRQSxNQU5zQjtBQU1iO0FBQ2pCRyw2QkFBdUJ0RSxVQUFVc0U7QUFQSCxLQUFoQixDQUFoQixDQXhDZSxDQWtEZjs7QUFDQVosZ0JBQVlzQixjQUFaLEdBQTZCckIsYUFBN0I7QUFDRCxHQS9Gd0MsQ0FpR3pDOzs7QUFDQUQsY0FBWXVCLDJCQUFaLENBQXdDakIsYUFBeEM7QUFFQSxTQUFPQSxhQUFQO0FBQ0QsQ0F0R0QsQyxDQXdHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFFQWtCLFlBQVksVUFBVWpHLGlCQUFWLEVBQTZCa0csY0FBN0IsRUFBNkM7QUFDdkQsTUFBSUMsWUFBWSxFQUFoQjtBQUNBQyxpQkFBZXBHLGlCQUFmLEVBQWtDLFVBQVVxRyxPQUFWLEVBQW1CO0FBQ25ERixjQUFVNUMsSUFBVixDQUFlMUosVUFBVXlNLHFCQUFWLENBQWdDQyxNQUFoQyxDQUNiRixPQURhLEVBQ0pILGNBREksQ0FBZjtBQUVELEdBSEQ7QUFLQSxTQUFPO0FBQ0xuTixVQUFNLFlBQVk7QUFDaEJwRixRQUFFSyxJQUFGLENBQU9tUyxTQUFQLEVBQWtCLFVBQVVLLFFBQVYsRUFBb0I7QUFDcENBLGlCQUFTek4sSUFBVDtBQUNELE9BRkQ7QUFHRDtBQUxJLEdBQVA7QUFPRCxDQWREOztBQWdCQXFOLGlCQUFpQixVQUFVcEcsaUJBQVYsRUFBNkJ5RyxlQUE3QixFQUE4QztBQUM3RCxNQUFJdlMsTUFBTTtBQUFDa0YsZ0JBQVk0RyxrQkFBa0I5RztBQUEvQixHQUFWOztBQUNBLE1BQUlzQyxjQUFjVCxnQkFBZ0JVLHFCQUFoQixDQUNoQnVFLGtCQUFrQjFFLFFBREYsQ0FBbEI7O0FBRUEsTUFBSUUsV0FBSixFQUFpQjtBQUNmN0gsTUFBRUssSUFBRixDQUFPd0gsV0FBUCxFQUFvQixVQUFVUCxFQUFWLEVBQWM7QUFDaEN3TCxzQkFBZ0I5UyxFQUFFK0gsTUFBRixDQUFTO0FBQUNULFlBQUlBO0FBQUwsT0FBVCxFQUFtQi9HLEdBQW5CLENBQWhCO0FBQ0QsS0FGRDs7QUFHQXVTLG9CQUFnQjlTLEVBQUUrSCxNQUFGLENBQVM7QUFBQ1Msc0JBQWdCLElBQWpCO0FBQXVCbEIsVUFBSTtBQUEzQixLQUFULEVBQTJDL0csR0FBM0MsQ0FBaEI7QUFDRCxHQUxELE1BS087QUFDTHVTLG9CQUFnQnZTLEdBQWhCO0FBQ0QsR0FYNEQsQ0FZN0Q7OztBQUNBdVMsa0JBQWdCO0FBQUVuSyxrQkFBYztBQUFoQixHQUFoQjtBQUNELENBZEQsQyxDQWdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBQ0FyRyxnQkFBZ0I3QixTQUFoQixDQUEwQmtRLHVCQUExQixHQUFvRCxVQUNoRHRFLGlCQURnRCxFQUM3Qm1CLE9BRDZCLEVBQ3BCSixTQURvQixFQUNUO0FBQ3pDLE1BQUkzSyxPQUFPLElBQVgsQ0FEeUMsQ0FHekM7QUFDQTs7QUFDQSxNQUFLK0ssV0FBVyxDQUFDSixVQUFVMkYsV0FBdkIsSUFDQyxDQUFDdkYsT0FBRCxJQUFZLENBQUNKLFVBQVU0RixLQUQ1QixFQUNvQztBQUNsQyxVQUFNLElBQUk5TixLQUFKLENBQVUsdUJBQXVCc0ksVUFBVSxTQUFWLEdBQXNCLFdBQTdDLElBQ0UsNkJBREYsSUFFR0EsVUFBVSxhQUFWLEdBQTBCLE9BRjdCLElBRXdDLFdBRmxELENBQU47QUFHRDs7QUFFRCxTQUFPL0ssS0FBS3dOLElBQUwsQ0FBVTVELGlCQUFWLEVBQTZCLFVBQVU5SCxHQUFWLEVBQWU7QUFDakQsUUFBSStDLEtBQUsvQyxJQUFJZ0QsR0FBYjtBQUNBLFdBQU9oRCxJQUFJZ0QsR0FBWCxDQUZpRCxDQUdqRDs7QUFDQSxXQUFPaEQsSUFBSTZKLEVBQVg7O0FBQ0EsUUFBSVosT0FBSixFQUFhO0FBQ1hKLGdCQUFVMkYsV0FBVixDQUFzQnpMLEVBQXRCLEVBQTBCL0MsR0FBMUIsRUFBK0IsSUFBL0I7QUFDRCxLQUZELE1BRU87QUFDTDZJLGdCQUFVNEYsS0FBVixDQUFnQjFMLEVBQWhCLEVBQW9CL0MsR0FBcEI7QUFDRDtBQUNGLEdBVk0sQ0FBUDtBQVdELENBeEJELEMsQ0EwQkE7QUFDQTtBQUNBOzs7QUFDQWxGLGVBQWU0VCxjQUFmLEdBQWdDalUsUUFBUXdCLFNBQXhDO0FBRUFuQixlQUFlNlQsVUFBZixHQUE0QjVRLGVBQTVCLEM7Ozs7Ozs7Ozs7O0FDMTFDQSxJQUFJcEQsU0FBU0MsSUFBSUMsT0FBSixDQUFZLGVBQVosQ0FBYjs7QUFFQStPLG1CQUFtQixVQUFuQjtBQUVBLElBQUlnRixpQkFBaUJDLFFBQVFDLEdBQVIsQ0FBWUMsMkJBQVosSUFBMkMsSUFBaEU7O0FBRUEsSUFBSUMsU0FBUyxVQUFVbkYsRUFBVixFQUFjO0FBQ3pCLFNBQU8sZUFBZUEsR0FBR29GLFdBQUgsRUFBZixHQUFrQyxJQUFsQyxHQUF5Q3BGLEdBQUdxRixVQUFILEVBQXpDLEdBQTJELEdBQWxFO0FBQ0QsQ0FGRDs7QUFJQUMsVUFBVSxVQUFVQyxFQUFWLEVBQWM7QUFDdEIsTUFBSUEsR0FBR0EsRUFBSCxLQUFVLEdBQWQsRUFDRSxPQUFPQSxHQUFHQyxDQUFILENBQUtyTSxHQUFaLENBREYsS0FFSyxJQUFJb00sR0FBR0EsRUFBSCxLQUFVLEdBQWQsRUFDSCxPQUFPQSxHQUFHQyxDQUFILENBQUtyTSxHQUFaLENBREcsS0FFQSxJQUFJb00sR0FBR0EsRUFBSCxLQUFVLEdBQWQsRUFDSCxPQUFPQSxHQUFHRSxFQUFILENBQU10TSxHQUFiLENBREcsS0FFQSxJQUFJb00sR0FBR0EsRUFBSCxLQUFVLEdBQWQsRUFDSCxNQUFNek8sTUFBTSxvREFDQTFELE1BQU1xUCxTQUFOLENBQWdCOEMsRUFBaEIsQ0FETixDQUFOLENBREcsS0FJSCxNQUFNek8sTUFBTSxpQkFBaUIxRCxNQUFNcVAsU0FBTixDQUFnQjhDLEVBQWhCLENBQXZCLENBQU47QUFDSCxDQVpEOztBQWNBN08sY0FBYyxVQUFVRixRQUFWLEVBQW9Ca1AsTUFBcEIsRUFBNEI7QUFDeEMsTUFBSXJSLE9BQU8sSUFBWDtBQUNBQSxPQUFLc1IsU0FBTCxHQUFpQm5QLFFBQWpCO0FBQ0FuQyxPQUFLdVIsT0FBTCxHQUFlRixNQUFmO0FBRUFyUixPQUFLd1IseUJBQUwsR0FBaUMsSUFBakM7QUFDQXhSLE9BQUt5UixvQkFBTCxHQUE0QixJQUE1QjtBQUNBelIsT0FBSzBSLFFBQUwsR0FBZ0IsS0FBaEI7QUFDQTFSLE9BQUsyUixXQUFMLEdBQW1CLElBQW5CO0FBQ0EzUixPQUFLNFIsWUFBTCxHQUFvQixJQUFJblYsTUFBSixFQUFwQjtBQUNBdUQsT0FBSzZSLFNBQUwsR0FBaUIsSUFBSXBPLFVBQVVxTyxTQUFkLENBQXdCO0FBQ3ZDQyxpQkFBYSxnQkFEMEI7QUFDUkMsY0FBVTtBQURGLEdBQXhCLENBQWpCO0FBR0FoUyxPQUFLaVMsa0JBQUwsR0FBMEI7QUFDeEJDLFFBQUksSUFBSUMsTUFBSixDQUFXLE1BQU03USxPQUFPOFEsYUFBUCxDQUFxQnBTLEtBQUt1UixPQUExQixDQUFOLEdBQTJDLEtBQXRELENBRG9CO0FBRXhCYyxTQUFLLENBQ0g7QUFBRW5CLFVBQUk7QUFBQ29CLGFBQUssQ0FBQyxHQUFELEVBQU0sR0FBTixFQUFXLEdBQVg7QUFBTjtBQUFOLEtBREcsRUFFSDtBQUNBO0FBQUVwQixVQUFJLEdBQU47QUFBVyxnQkFBVTtBQUFFcUIsaUJBQVM7QUFBWDtBQUFyQixLQUhHLEVBSUg7QUFBRXJCLFVBQUksR0FBTjtBQUFXLHdCQUFrQjtBQUE3QixLQUpHO0FBRm1CLEdBQTFCLENBYndDLENBdUJ4QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBQ0FsUixPQUFLd1Msa0JBQUwsR0FBMEIsRUFBMUI7QUFDQXhTLE9BQUt5UyxnQkFBTCxHQUF3QixJQUF4QjtBQUVBelMsT0FBSzBTLHFCQUFMLEdBQTZCLElBQUl2UyxJQUFKLENBQVM7QUFDcEN3UywwQkFBc0I7QUFEYyxHQUFULENBQTdCO0FBSUEzUyxPQUFLNFMsV0FBTCxHQUFtQixJQUFJdFIsT0FBT3VSLGlCQUFYLEVBQW5CO0FBQ0E3UyxPQUFLOFMsYUFBTCxHQUFxQixLQUFyQjs7QUFFQTlTLE9BQUsrUyxhQUFMO0FBQ0QsQ0FwREQ7O0FBc0RBeFYsRUFBRStILE1BQUYsQ0FBU2pELFlBQVlyRSxTQUFyQixFQUFnQztBQUM5QjJFLFFBQU0sWUFBWTtBQUNoQixRQUFJM0MsT0FBTyxJQUFYO0FBQ0EsUUFBSUEsS0FBSzBSLFFBQVQsRUFDRTtBQUNGMVIsU0FBSzBSLFFBQUwsR0FBZ0IsSUFBaEI7QUFDQSxRQUFJMVIsS0FBSzJSLFdBQVQsRUFDRTNSLEtBQUsyUixXQUFMLENBQWlCaFAsSUFBakIsR0FOYyxDQU9oQjtBQUNELEdBVDZCO0FBVTlCcVEsZ0JBQWMsVUFBVS9DLE9BQVYsRUFBbUJsTyxRQUFuQixFQUE2QjtBQUN6QyxRQUFJL0IsT0FBTyxJQUFYO0FBQ0EsUUFBSUEsS0FBSzBSLFFBQVQsRUFDRSxNQUFNLElBQUlqUCxLQUFKLENBQVUsd0NBQVYsQ0FBTixDQUh1QyxDQUt6Qzs7QUFDQXpDLFNBQUs0UixZQUFMLENBQWtCMVAsSUFBbEI7O0FBRUEsUUFBSStRLG1CQUFtQmxSLFFBQXZCO0FBQ0FBLGVBQVdULE9BQU9DLGVBQVAsQ0FBdUIsVUFBVTJSLFlBQVYsRUFBd0I7QUFDeEQ7QUFDQUQsdUJBQWlCbFUsTUFBTWQsS0FBTixDQUFZaVYsWUFBWixDQUFqQjtBQUNELEtBSFUsRUFHUixVQUFVMVIsR0FBVixFQUFlO0FBQ2hCRixhQUFPNlIsTUFBUCxDQUFjLHlCQUFkLEVBQXlDM1IsSUFBSTRSLEtBQTdDO0FBQ0QsS0FMVSxDQUFYOztBQU1BLFFBQUlDLGVBQWVyVCxLQUFLNlIsU0FBTCxDQUFlMUIsTUFBZixDQUFzQkYsT0FBdEIsRUFBK0JsTyxRQUEvQixDQUFuQjs7QUFDQSxXQUFPO0FBQ0xZLFlBQU0sWUFBWTtBQUNoQjBRLHFCQUFhMVEsSUFBYjtBQUNEO0FBSEksS0FBUDtBQUtELEdBL0I2QjtBQWdDOUI7QUFDQTtBQUNBMlEsb0JBQWtCLFVBQVV2UixRQUFWLEVBQW9CO0FBQ3BDLFFBQUkvQixPQUFPLElBQVg7QUFDQSxRQUFJQSxLQUFLMFIsUUFBVCxFQUNFLE1BQU0sSUFBSWpQLEtBQUosQ0FBVSw0Q0FBVixDQUFOO0FBQ0YsV0FBT3pDLEtBQUswUyxxQkFBTCxDQUEyQjNPLFFBQTNCLENBQW9DaEMsUUFBcEMsQ0FBUDtBQUNELEdBdkM2QjtBQXdDOUI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBd1IscUJBQW1CLFlBQVk7QUFDN0IsUUFBSXZULE9BQU8sSUFBWDtBQUNBLFFBQUlBLEtBQUswUixRQUFULEVBQ0UsTUFBTSxJQUFJalAsS0FBSixDQUFVLDZDQUFWLENBQU4sQ0FIMkIsQ0FLN0I7QUFDQTs7QUFDQXpDLFNBQUs0UixZQUFMLENBQWtCMVAsSUFBbEI7O0FBQ0EsUUFBSXNSLFNBQUo7O0FBRUEsV0FBTyxDQUFDeFQsS0FBSzBSLFFBQWIsRUFBdUI7QUFDckI7QUFDQTtBQUNBO0FBQ0EsVUFBSTtBQUNGOEIsb0JBQVl4VCxLQUFLd1IseUJBQUwsQ0FBK0J4SSxPQUEvQixDQUNWMEMsZ0JBRFUsRUFDUTFMLEtBQUtpUyxrQkFEYixFQUVWO0FBQUNuRyxrQkFBUTtBQUFDSCxnQkFBSTtBQUFMLFdBQVQ7QUFBa0JMLGdCQUFNO0FBQUNtSSxzQkFBVSxDQUFDO0FBQVo7QUFBeEIsU0FGVSxDQUFaO0FBR0E7QUFDRCxPQUxELENBS0UsT0FBT2hQLENBQVAsRUFBVTtBQUNWO0FBQ0E7QUFDQW5ELGVBQU82UixNQUFQLENBQWMsNkNBQTZDMU8sQ0FBM0Q7O0FBQ0FuRCxlQUFPb1MsV0FBUCxDQUFtQixHQUFuQjtBQUNEO0FBQ0Y7O0FBRUQsUUFBSTFULEtBQUswUixRQUFULEVBQ0U7O0FBRUYsUUFBSSxDQUFDOEIsU0FBTCxFQUFnQjtBQUNkO0FBQ0E7QUFDRDs7QUFFRCxRQUFJN0gsS0FBSzZILFVBQVU3SCxFQUFuQjtBQUNBLFFBQUksQ0FBQ0EsRUFBTCxFQUNFLE1BQU1sSixNQUFNLDZCQUE2QjFELE1BQU1xUCxTQUFOLENBQWdCb0YsU0FBaEIsQ0FBbkMsQ0FBTjs7QUFFRixRQUFJeFQsS0FBS3lTLGdCQUFMLElBQXlCOUcsR0FBR2dJLGVBQUgsQ0FBbUIzVCxLQUFLeVMsZ0JBQXhCLENBQTdCLEVBQXdFO0FBQ3RFO0FBQ0E7QUFDRCxLQTFDNEIsQ0E2QzdCO0FBQ0E7QUFDQTs7O0FBQ0EsUUFBSW1CLGNBQWM1VCxLQUFLd1Msa0JBQUwsQ0FBd0IzSyxNQUExQzs7QUFDQSxXQUFPK0wsY0FBYyxDQUFkLEdBQWtCLENBQWxCLElBQXVCNVQsS0FBS3dTLGtCQUFMLENBQXdCb0IsY0FBYyxDQUF0QyxFQUF5Q2pJLEVBQXpDLENBQTRDa0ksV0FBNUMsQ0FBd0RsSSxFQUF4RCxDQUE5QixFQUEyRjtBQUN6RmlJO0FBQ0Q7O0FBQ0QsUUFBSXJFLElBQUksSUFBSTlTLE1BQUosRUFBUjs7QUFDQXVELFNBQUt3UyxrQkFBTCxDQUF3QnNCLE1BQXhCLENBQStCRixXQUEvQixFQUE0QyxDQUE1QyxFQUErQztBQUFDakksVUFBSUEsRUFBTDtBQUFTNUksY0FBUXdNO0FBQWpCLEtBQS9DOztBQUNBQSxNQUFFck4sSUFBRjtBQUNELEdBcEc2QjtBQXFHOUI2USxpQkFBZSxZQUFZO0FBQ3pCLFFBQUkvUyxPQUFPLElBQVgsQ0FEeUIsQ0FFekI7O0FBQ0EsUUFBSStULGFBQWFyWCxJQUFJQyxPQUFKLENBQVksYUFBWixDQUFqQjs7QUFDQSxRQUFJb1gsV0FBV0MsS0FBWCxDQUFpQmhVLEtBQUtzUixTQUF0QixFQUFpQzJDLFFBQWpDLEtBQThDLE9BQWxELEVBQTJEO0FBQ3pELFlBQU14UixNQUFNLDZEQUNBLHFCQUROLENBQU47QUFFRCxLQVB3QixDQVN6QjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQXpDLFNBQUt5UixvQkFBTCxHQUE0QixJQUFJNVIsZUFBSixDQUMxQkcsS0FBS3NSLFNBRHFCLEVBQ1Y7QUFBQ3ZRLGdCQUFVO0FBQVgsS0FEVSxDQUE1QixDQXBCeUIsQ0FzQnpCO0FBQ0E7QUFDQTs7QUFDQWYsU0FBS3dSLHlCQUFMLEdBQWlDLElBQUkzUixlQUFKLENBQy9CRyxLQUFLc1IsU0FEMEIsRUFDZjtBQUFDdlEsZ0JBQVU7QUFBWCxLQURlLENBQWpDLENBekJ5QixDQTRCekI7QUFDQTtBQUNBO0FBQ0E7O0FBQ0EsUUFBSXdPLElBQUksSUFBSTlTLE1BQUosRUFBUjs7QUFDQXVELFNBQUt3Uix5QkFBTCxDQUErQnhRLEVBQS9CLENBQWtDa1QsS0FBbEMsR0FBMENDLE9BQTFDLENBQ0U7QUFBRUMsZ0JBQVU7QUFBWixLQURGLEVBQ21CN0UsRUFBRXROLFFBQUYsRUFEbkI7O0FBRUEsUUFBSVAsY0FBYzZOLEVBQUVyTixJQUFGLEVBQWxCOztBQUVBLFFBQUksRUFBRVIsZUFBZUEsWUFBWTJTLE9BQTdCLENBQUosRUFBMkM7QUFDekMsWUFBTTVSLE1BQU0sNkRBQ0EscUJBRE4sQ0FBTjtBQUVELEtBeEN3QixDQTBDekI7OztBQUNBLFFBQUk2UixpQkFBaUJ0VSxLQUFLd1IseUJBQUwsQ0FBK0J4SSxPQUEvQixDQUNuQjBDLGdCQURtQixFQUNELEVBREMsRUFDRztBQUFDSixZQUFNO0FBQUNtSSxrQkFBVSxDQUFDO0FBQVosT0FBUDtBQUF1QjNILGNBQVE7QUFBQ0gsWUFBSTtBQUFMO0FBQS9CLEtBREgsQ0FBckI7O0FBR0EsUUFBSTRJLGdCQUFnQmhYLEVBQUVVLEtBQUYsQ0FBUStCLEtBQUtpUyxrQkFBYixDQUFwQjs7QUFDQSxRQUFJcUMsY0FBSixFQUFvQjtBQUNsQjtBQUNBQyxvQkFBYzVJLEVBQWQsR0FBbUI7QUFBQ29DLGFBQUt1RyxlQUFlM0k7QUFBckIsT0FBbkIsQ0FGa0IsQ0FHbEI7QUFDQTtBQUNBOztBQUNBM0wsV0FBS3lTLGdCQUFMLEdBQXdCNkIsZUFBZTNJLEVBQXZDO0FBQ0Q7O0FBRUQsUUFBSS9CLG9CQUFvQixJQUFJYixpQkFBSixDQUN0QjJDLGdCQURzQixFQUNKNkksYUFESSxFQUNXO0FBQUN2SyxnQkFBVTtBQUFYLEtBRFgsQ0FBeEI7QUFHQWhLLFNBQUsyUixXQUFMLEdBQW1CM1IsS0FBS3lSLG9CQUFMLENBQTBCakUsSUFBMUIsQ0FDakI1RCxpQkFEaUIsRUFDRSxVQUFVOUgsR0FBVixFQUFlO0FBQ2hDOUIsV0FBSzRTLFdBQUwsQ0FBaUJ6RixJQUFqQixDQUFzQnJMLEdBQXRCOztBQUNBOUIsV0FBS3dVLGlCQUFMO0FBQ0QsS0FKZ0IsQ0FBbkI7O0FBTUF4VSxTQUFLNFIsWUFBTCxDQUFrQjZDLE1BQWxCO0FBQ0QsR0F2SzZCO0FBeUs5QkQscUJBQW1CLFlBQVk7QUFDN0IsUUFBSXhVLE9BQU8sSUFBWDtBQUNBLFFBQUlBLEtBQUs4UyxhQUFULEVBQ0U7QUFDRjlTLFNBQUs4UyxhQUFMLEdBQXFCLElBQXJCO0FBQ0F4UixXQUFPMk0sS0FBUCxDQUFhLFlBQVk7QUFDdkIsVUFBSTtBQUNGLGVBQU8sQ0FBRWpPLEtBQUswUixRQUFQLElBQW1CLENBQUUxUixLQUFLNFMsV0FBTCxDQUFpQjhCLE9BQWpCLEVBQTVCLEVBQXdEO0FBQ3REO0FBQ0E7QUFDQSxjQUFJMVUsS0FBSzRTLFdBQUwsQ0FBaUIvSyxNQUFqQixHQUEwQjZJLGNBQTlCLEVBQThDO0FBQzVDLGdCQUFJOEMsWUFBWXhULEtBQUs0UyxXQUFMLENBQWlCK0IsR0FBakIsRUFBaEI7O0FBQ0EzVSxpQkFBSzRTLFdBQUwsQ0FBaUJnQyxLQUFqQjs7QUFFQTVVLGlCQUFLMFMscUJBQUwsQ0FBMkI5VSxJQUEzQixDQUFnQyxVQUFVbUUsUUFBVixFQUFvQjtBQUNsREE7QUFDQSxxQkFBTyxJQUFQO0FBQ0QsYUFIRCxFQUo0QyxDQVM1QztBQUNBOzs7QUFDQS9CLGlCQUFLNlUsbUJBQUwsQ0FBeUJyQixVQUFVN0gsRUFBbkM7O0FBQ0E7QUFDRDs7QUFFRCxjQUFJN0osTUFBTTlCLEtBQUs0UyxXQUFMLENBQWlCa0MsS0FBakIsRUFBVjs7QUFFQSxjQUFJLEVBQUVoVCxJQUFJb1EsRUFBSixJQUFVcFEsSUFBSW9RLEVBQUosQ0FBT3JLLE1BQVAsR0FBZ0I3SCxLQUFLdVIsT0FBTCxDQUFhMUosTUFBYixHQUFzQixDQUFoRCxJQUNBL0YsSUFBSW9RLEVBQUosQ0FBTzdULE1BQVAsQ0FBYyxDQUFkLEVBQWlCMkIsS0FBS3VSLE9BQUwsQ0FBYTFKLE1BQWIsR0FBc0IsQ0FBdkMsTUFDQzdILEtBQUt1UixPQUFMLEdBQWUsR0FGbEIsQ0FBSixFQUU2QjtBQUMzQixrQkFBTSxJQUFJOU8sS0FBSixDQUFVLGVBQVYsQ0FBTjtBQUNEOztBQUVELGNBQUl3TixVQUFVO0FBQUNqTix3QkFBWWxCLElBQUlvUSxFQUFKLENBQU83VCxNQUFQLENBQWMyQixLQUFLdVIsT0FBTCxDQUFhMUosTUFBYixHQUFzQixDQUFwQyxDQUFiO0FBQ0M5Qiw0QkFBZ0IsS0FEakI7QUFFQ0csMEJBQWMsS0FGZjtBQUdDZ0wsZ0JBQUlwUDtBQUhMLFdBQWQsQ0ExQnNELENBK0J0RDtBQUNBOztBQUNBLGNBQUltTyxRQUFRak4sVUFBUixLQUF1QixNQUEzQixFQUFtQztBQUNqQyxnQkFBSWxCLElBQUlxUCxDQUFKLENBQU1qTCxZQUFWLEVBQXdCO0FBQ3RCLHFCQUFPK0osUUFBUWpOLFVBQWY7QUFDQWlOLHNCQUFRL0osWUFBUixHQUF1QixJQUF2QjtBQUNELGFBSEQsTUFHTyxJQUFJM0ksRUFBRXVELEdBQUYsQ0FBTWdCLElBQUlxUCxDQUFWLEVBQWEsTUFBYixDQUFKLEVBQTBCO0FBQy9CbEIsc0JBQVFqTixVQUFSLEdBQXFCbEIsSUFBSXFQLENBQUosQ0FBTW5MLElBQTNCO0FBQ0FpSyxzQkFBUWxLLGNBQVIsR0FBeUIsSUFBekI7QUFDQWtLLHNCQUFRcEwsRUFBUixHQUFhLElBQWI7QUFDRCxhQUpNLE1BSUE7QUFDTCxvQkFBTXBDLE1BQU0scUJBQXFCc1MsS0FBSzNHLFNBQUwsQ0FBZXRNLEdBQWYsQ0FBM0IsQ0FBTjtBQUNEO0FBQ0YsV0FYRCxNQVdPO0FBQ0w7QUFDQW1PLG9CQUFRcEwsRUFBUixHQUFhb00sUUFBUW5QLEdBQVIsQ0FBYjtBQUNEOztBQUVEOUIsZUFBSzZSLFNBQUwsQ0FBZW1ELElBQWYsQ0FBb0IvRSxPQUFwQixFQWpEc0QsQ0FtRHREO0FBQ0E7OztBQUNBLGNBQUksQ0FBQ25PLElBQUk2SixFQUFULEVBQ0UsTUFBTWxKLE1BQU0sNkJBQTZCMUQsTUFBTXFQLFNBQU4sQ0FBZ0J0TSxHQUFoQixDQUFuQyxDQUFOOztBQUNGOUIsZUFBSzZVLG1CQUFMLENBQXlCL1MsSUFBSTZKLEVBQTdCO0FBQ0Q7QUFDRixPQTFERCxTQTBEVTtBQUNSM0wsYUFBSzhTLGFBQUwsR0FBcUIsS0FBckI7QUFDRDtBQUNGLEtBOUREO0FBK0RELEdBN082QjtBQThPOUIrQix1QkFBcUIsVUFBVWxKLEVBQVYsRUFBYztBQUNqQyxRQUFJM0wsT0FBTyxJQUFYO0FBQ0FBLFNBQUt5UyxnQkFBTCxHQUF3QjlHLEVBQXhCOztBQUNBLFdBQU8sQ0FBQ3BPLEVBQUVtWCxPQUFGLENBQVUxVSxLQUFLd1Msa0JBQWYsQ0FBRCxJQUF1Q3hTLEtBQUt3UyxrQkFBTCxDQUF3QixDQUF4QixFQUEyQjdHLEVBQTNCLENBQThCZ0ksZUFBOUIsQ0FBOEMzVCxLQUFLeVMsZ0JBQW5ELENBQTlDLEVBQW9IO0FBQ2xILFVBQUl3QyxZQUFZalYsS0FBS3dTLGtCQUFMLENBQXdCc0MsS0FBeEIsRUFBaEI7O0FBQ0FHLGdCQUFVbFMsTUFBVixDQUFpQjBSLE1BQWpCO0FBQ0Q7QUFDRixHQXJQNkI7QUF1UDlCO0FBQ0FTLHVCQUFxQixVQUFTclgsS0FBVCxFQUFnQjtBQUNuQzZTLHFCQUFpQjdTLEtBQWpCO0FBQ0QsR0ExUDZCO0FBMlA5QnNYLHNCQUFvQixZQUFXO0FBQzdCekUscUJBQWlCQyxRQUFRQyxHQUFSLENBQVlDLDJCQUFaLElBQTJDLElBQTVEO0FBQ0Q7QUE3UDZCLENBQWhDLEU7Ozs7Ozs7Ozs7O0FDOUVBLElBQUlwVSxTQUFTQyxJQUFJQyxPQUFKLENBQVksZUFBWixDQUFiOztBQUVBOFIscUJBQXFCLFVBQVUxTyxPQUFWLEVBQW1CO0FBQ3RDLE1BQUlDLE9BQU8sSUFBWDtBQUVBLE1BQUksQ0FBQ0QsT0FBRCxJQUFZLENBQUN4QyxFQUFFdUQsR0FBRixDQUFNZixPQUFOLEVBQWUsU0FBZixDQUFqQixFQUNFLE1BQU0wQyxNQUFNLHdCQUFOLENBQU47QUFFRkwsVUFBUWdULEtBQVIsSUFBaUJoVCxRQUFRZ1QsS0FBUixDQUFjQyxLQUFkLENBQW9CQyxtQkFBcEIsQ0FDZixnQkFEZSxFQUNHLHNCQURILEVBQzJCLENBRDNCLENBQWpCO0FBR0F0VixPQUFLdVYsUUFBTCxHQUFnQnhWLFFBQVFnTCxPQUF4Qjs7QUFDQS9LLE9BQUt3VixPQUFMLEdBQWV6VixRQUFRMk8sTUFBUixJQUFrQixZQUFZLENBQUUsQ0FBL0M7O0FBQ0ExTyxPQUFLeVYsTUFBTCxHQUFjLElBQUluVSxPQUFPb1UsaUJBQVgsRUFBZDtBQUNBMVYsT0FBSzJWLFFBQUwsR0FBZ0IsRUFBaEI7QUFDQTNWLE9BQUs0UixZQUFMLEdBQW9CLElBQUluVixNQUFKLEVBQXBCO0FBQ0F1RCxPQUFLNFYsTUFBTCxHQUFjLElBQUlqUixnQkFBZ0JrUixzQkFBcEIsQ0FBMkM7QUFDdkQ5SyxhQUFTaEwsUUFBUWdMO0FBRHNDLEdBQTNDLENBQWQsQ0Fkc0MsQ0FnQnRDO0FBQ0E7QUFDQTs7QUFDQS9LLE9BQUs4Vix1Q0FBTCxHQUErQyxDQUEvQzs7QUFFQXZZLElBQUVLLElBQUYsQ0FBT29DLEtBQUsrVixhQUFMLEVBQVAsRUFBNkIsVUFBVUMsWUFBVixFQUF3QjtBQUNuRGhXLFNBQUtnVyxZQUFMLElBQXFCO0FBQVU7QUFBVztBQUN4Q2hXLFdBQUtpVyxjQUFMLENBQW9CRCxZQUFwQixFQUFrQ3pZLEVBQUUyWSxPQUFGLENBQVV0TixTQUFWLENBQWxDO0FBQ0QsS0FGRDtBQUdELEdBSkQ7QUFLRCxDQTFCRDs7QUE0QkFyTCxFQUFFK0gsTUFBRixDQUFTbUosbUJBQW1CelEsU0FBNUIsRUFBdUM7QUFDckM0UiwrQkFBNkIsVUFBVXVHLE1BQVYsRUFBa0I7QUFDN0MsUUFBSW5XLE9BQU8sSUFBWCxDQUQ2QyxDQUc3QztBQUNBO0FBQ0E7QUFDQTs7QUFDQSxRQUFJLENBQUNBLEtBQUt5VixNQUFMLENBQVlXLGFBQVosRUFBTCxFQUNFLE1BQU0sSUFBSTNULEtBQUosQ0FBVSxzRUFBVixDQUFOO0FBQ0YsTUFBRXpDLEtBQUs4Vix1Q0FBUDtBQUVBMVQsWUFBUWdULEtBQVIsSUFBaUJoVCxRQUFRZ1QsS0FBUixDQUFjQyxLQUFkLENBQW9CQyxtQkFBcEIsQ0FDZixnQkFEZSxFQUNHLGlCQURILEVBQ3NCLENBRHRCLENBQWpCOztBQUdBdFYsU0FBS3lWLE1BQUwsQ0FBWVksT0FBWixDQUFvQixZQUFZO0FBQzlCclcsV0FBSzJWLFFBQUwsQ0FBY1EsT0FBT3JSLEdBQXJCLElBQTRCcVIsTUFBNUIsQ0FEOEIsQ0FFOUI7QUFDQTs7QUFDQW5XLFdBQUtzVyxTQUFMLENBQWVILE1BQWY7O0FBQ0EsUUFBRW5XLEtBQUs4Vix1Q0FBUDtBQUNELEtBTkQsRUFkNkMsQ0FxQjdDOzs7QUFDQTlWLFNBQUs0UixZQUFMLENBQWtCMVAsSUFBbEI7QUFDRCxHQXhCb0M7QUEwQnJDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBcVUsZ0JBQWMsVUFBVTFSLEVBQVYsRUFBYztBQUMxQixRQUFJN0UsT0FBTyxJQUFYLENBRDBCLENBRzFCO0FBQ0E7QUFDQTs7QUFDQSxRQUFJLENBQUNBLEtBQUt3VyxNQUFMLEVBQUwsRUFDRSxNQUFNLElBQUkvVCxLQUFKLENBQVUsbURBQVYsQ0FBTjtBQUVGLFdBQU96QyxLQUFLMlYsUUFBTCxDQUFjOVEsRUFBZCxDQUFQO0FBRUF6QyxZQUFRZ1QsS0FBUixJQUFpQmhULFFBQVFnVCxLQUFSLENBQWNDLEtBQWQsQ0FBb0JDLG1CQUFwQixDQUNmLGdCQURlLEVBQ0csaUJBREgsRUFDc0IsQ0FBQyxDQUR2QixDQUFqQjs7QUFHQSxRQUFJL1gsRUFBRW1YLE9BQUYsQ0FBVTFVLEtBQUsyVixRQUFmLEtBQ0EzVixLQUFLOFYsdUNBQUwsS0FBaUQsQ0FEckQsRUFDd0Q7QUFDdEQ5VixXQUFLeVcsS0FBTDtBQUNEO0FBQ0YsR0FsRG9DO0FBbURyQ0EsU0FBTyxVQUFVMVcsT0FBVixFQUFtQjtBQUN4QixRQUFJQyxPQUFPLElBQVg7QUFDQUQsY0FBVUEsV0FBVyxFQUFyQixDQUZ3QixDQUl4QjtBQUNBOztBQUNBLFFBQUksQ0FBRUMsS0FBS3dXLE1BQUwsRUFBRixJQUFtQixDQUFFelcsUUFBUTJXLGNBQWpDLEVBQ0UsTUFBTWpVLE1BQU0sNkJBQU4sQ0FBTixDQVBzQixDQVN4QjtBQUNBOztBQUNBekMsU0FBS3dWLE9BQUw7O0FBQ0FwVCxZQUFRZ1QsS0FBUixJQUFpQmhULFFBQVFnVCxLQUFSLENBQWNDLEtBQWQsQ0FBb0JDLG1CQUFwQixDQUNmLGdCQURlLEVBQ0csc0JBREgsRUFDMkIsQ0FBQyxDQUQ1QixDQUFqQixDQVp3QixDQWV4QjtBQUNBOztBQUNBdFYsU0FBSzJWLFFBQUwsR0FBZ0IsSUFBaEI7QUFDRCxHQXJFb0M7QUF1RXJDO0FBQ0E7QUFDQWdCLFNBQU8sWUFBWTtBQUNqQixRQUFJM1csT0FBTyxJQUFYOztBQUNBQSxTQUFLeVYsTUFBTCxDQUFZbUIsU0FBWixDQUFzQixZQUFZO0FBQ2hDLFVBQUk1VyxLQUFLd1csTUFBTCxFQUFKLEVBQ0UsTUFBTS9ULE1BQU0sMENBQU4sQ0FBTjs7QUFDRnpDLFdBQUs0UixZQUFMLENBQWtCNkMsTUFBbEI7QUFDRCxLQUpEO0FBS0QsR0FoRm9DO0FBa0ZyQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQW9DLGNBQVksVUFBVXJWLEdBQVYsRUFBZTtBQUN6QixRQUFJeEIsT0FBTyxJQUFYOztBQUNBQSxTQUFLeVYsTUFBTCxDQUFZWSxPQUFaLENBQW9CLFlBQVk7QUFDOUIsVUFBSXJXLEtBQUt3VyxNQUFMLEVBQUosRUFDRSxNQUFNL1QsTUFBTSxpREFBTixDQUFOOztBQUNGekMsV0FBS3lXLEtBQUwsQ0FBVztBQUFDQyx3QkFBZ0I7QUFBakIsT0FBWDs7QUFDQTFXLFdBQUs0UixZQUFMLENBQWtCa0YsS0FBbEIsQ0FBd0J0VixHQUF4QjtBQUNELEtBTEQ7QUFNRCxHQWhHb0M7QUFrR3JDO0FBQ0E7QUFDQTtBQUNBdVYsV0FBUyxVQUFValIsRUFBVixFQUFjO0FBQ3JCLFFBQUk5RixPQUFPLElBQVg7O0FBQ0FBLFNBQUt5VixNQUFMLENBQVltQixTQUFaLENBQXNCLFlBQVk7QUFDaEMsVUFBSSxDQUFDNVcsS0FBS3dXLE1BQUwsRUFBTCxFQUNFLE1BQU0vVCxNQUFNLHVEQUFOLENBQU47QUFDRnFEO0FBQ0QsS0FKRDtBQUtELEdBNUdvQztBQTZHckNpUSxpQkFBZSxZQUFZO0FBQ3pCLFFBQUkvVixPQUFPLElBQVg7QUFDQSxRQUFJQSxLQUFLdVYsUUFBVCxFQUNFLE9BQU8sQ0FBQyxhQUFELEVBQWdCLFNBQWhCLEVBQTJCLGFBQTNCLEVBQTBDLFNBQTFDLENBQVAsQ0FERixLQUdFLE9BQU8sQ0FBQyxPQUFELEVBQVUsU0FBVixFQUFxQixTQUFyQixDQUFQO0FBQ0gsR0FuSG9DO0FBb0hyQ2lCLFVBQVEsWUFBWTtBQUNsQixXQUFPLEtBQUs1RSxZQUFMLENBQWtCb0YsVUFBbEIsRUFBUDtBQUNELEdBdEhvQztBQXVIckNmLGtCQUFnQixVQUFVRCxZQUFWLEVBQXdCaUIsSUFBeEIsRUFBOEI7QUFDNUMsUUFBSWpYLE9BQU8sSUFBWDs7QUFDQUEsU0FBS3lWLE1BQUwsQ0FBWW1CLFNBQVosQ0FBc0IsWUFBWTtBQUNoQztBQUNBLFVBQUksQ0FBQzVXLEtBQUsyVixRQUFWLEVBQ0UsT0FIOEIsQ0FLaEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQTNWLFdBQUs0VixNQUFMLENBQVlzQixXQUFaLENBQXdCbEIsWUFBeEIsRUFBc0NyTixLQUF0QyxDQUE0QyxJQUE1QyxFQUFrRDVKLE1BQU1kLEtBQU4sQ0FBWWdaLElBQVosQ0FBbEQsRUFWZ0MsQ0FZaEM7QUFDQTs7O0FBQ0EsVUFBSSxDQUFDalgsS0FBS3dXLE1BQUwsRUFBRCxJQUNDUixpQkFBaUIsT0FBakIsSUFBNEJBLGlCQUFpQixhQURsRCxFQUNrRTtBQUNoRSxjQUFNLElBQUl2VCxLQUFKLENBQVUsU0FBU3VULFlBQVQsR0FBd0Isc0JBQWxDLENBQU47QUFDRCxPQWpCK0IsQ0FtQmhDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBelksUUFBRUssSUFBRixDQUFPTCxFQUFFNFosSUFBRixDQUFPblgsS0FBSzJWLFFBQVosQ0FBUCxFQUE4QixVQUFVeUIsUUFBVixFQUFvQjtBQUNoRCxZQUFJakIsU0FBU25XLEtBQUsyVixRQUFMLElBQWlCM1YsS0FBSzJWLFFBQUwsQ0FBY3lCLFFBQWQsQ0FBOUI7QUFDQSxZQUFJLENBQUNqQixNQUFMLEVBQ0U7QUFDRixZQUFJcFUsV0FBV29VLE9BQU8sTUFBTUgsWUFBYixDQUFmLENBSmdELENBS2hEOztBQUNBalUsb0JBQVlBLFNBQVM0RyxLQUFULENBQWUsSUFBZixFQUFxQjVKLE1BQU1kLEtBQU4sQ0FBWWdaLElBQVosQ0FBckIsQ0FBWjtBQUNELE9BUEQ7QUFRRCxLQWhDRDtBQWlDRCxHQTFKb0M7QUE0SnJDO0FBQ0E7QUFDQTtBQUNBO0FBQ0FYLGFBQVcsVUFBVUgsTUFBVixFQUFrQjtBQUMzQixRQUFJblcsT0FBTyxJQUFYO0FBQ0EsUUFBSUEsS0FBS3lWLE1BQUwsQ0FBWVcsYUFBWixFQUFKLEVBQ0UsTUFBTTNULE1BQU0sa0RBQU4sQ0FBTjtBQUNGLFFBQUk0VSxNQUFNclgsS0FBS3VWLFFBQUwsR0FBZ0JZLE9BQU9tQixZQUF2QixHQUFzQ25CLE9BQU9vQixNQUF2RDtBQUNBLFFBQUksQ0FBQ0YsR0FBTCxFQUNFLE9BTnlCLENBTzNCOztBQUNBclgsU0FBSzRWLE1BQUwsQ0FBWTRCLElBQVosQ0FBaUJ0TSxPQUFqQixDQUF5QixVQUFVcEosR0FBVixFQUFlK0MsRUFBZixFQUFtQjtBQUMxQyxVQUFJLENBQUN0SCxFQUFFdUQsR0FBRixDQUFNZCxLQUFLMlYsUUFBWCxFQUFxQlEsT0FBT3JSLEdBQTVCLENBQUwsRUFDRSxNQUFNckMsTUFBTSxpREFBTixDQUFOO0FBQ0YsVUFBSXFKLFNBQVMvTSxNQUFNZCxLQUFOLENBQVk2RCxHQUFaLENBQWI7QUFDQSxhQUFPZ0ssT0FBT2hILEdBQWQ7QUFDQSxVQUFJOUUsS0FBS3VWLFFBQVQsRUFDRThCLElBQUl4UyxFQUFKLEVBQVFpSCxNQUFSLEVBQWdCLElBQWhCLEVBREYsQ0FDeUI7QUFEekIsV0FHRXVMLElBQUl4UyxFQUFKLEVBQVFpSCxNQUFSO0FBQ0gsS0FURDtBQVVEO0FBbExvQyxDQUF2Qzs7QUFzTEEsSUFBSTJMLHNCQUFzQixDQUExQjs7QUFDQTdJLGdCQUFnQixVQUFVUCxXQUFWLEVBQXVCMUQsU0FBdkIsRUFBa0M7QUFDaEQsTUFBSTNLLE9BQU8sSUFBWCxDQURnRCxDQUVoRDtBQUNBOztBQUNBQSxPQUFLMFgsWUFBTCxHQUFvQnJKLFdBQXBCOztBQUNBOVEsSUFBRUssSUFBRixDQUFPeVEsWUFBWTBILGFBQVosRUFBUCxFQUFvQyxVQUFVNVgsSUFBVixFQUFnQjtBQUNsRCxRQUFJd00sVUFBVXhNLElBQVYsQ0FBSixFQUFxQjtBQUNuQjZCLFdBQUssTUFBTTdCLElBQVgsSUFBbUJ3TSxVQUFVeE0sSUFBVixDQUFuQjtBQUNELEtBRkQsTUFFTyxJQUFJQSxTQUFTLGFBQVQsSUFBMEJ3TSxVQUFVNEYsS0FBeEMsRUFBK0M7QUFDcEQ7QUFDQTtBQUNBO0FBQ0E7QUFDQXZRLFdBQUtzWCxZQUFMLEdBQW9CLFVBQVV6UyxFQUFWLEVBQWNpSCxNQUFkLEVBQXNCNkwsTUFBdEIsRUFBOEI7QUFDaERoTixrQkFBVTRGLEtBQVYsQ0FBZ0IxTCxFQUFoQixFQUFvQmlILE1BQXBCO0FBQ0QsT0FGRDtBQUdEO0FBQ0YsR0FaRDs7QUFhQTlMLE9BQUswUixRQUFMLEdBQWdCLEtBQWhCO0FBQ0ExUixPQUFLOEUsR0FBTCxHQUFXMlMscUJBQVg7QUFDRCxDQXBCRDs7QUFxQkE3SSxjQUFjNVEsU0FBZCxDQUF3QjJFLElBQXhCLEdBQStCLFlBQVk7QUFDekMsTUFBSTNDLE9BQU8sSUFBWDtBQUNBLE1BQUlBLEtBQUswUixRQUFULEVBQ0U7QUFDRjFSLE9BQUswUixRQUFMLEdBQWdCLElBQWhCOztBQUNBMVIsT0FBSzBYLFlBQUwsQ0FBa0JuQixZQUFsQixDQUErQnZXLEtBQUs4RSxHQUFwQztBQUNELENBTkQsQzs7Ozs7Ozs7Ozs7QUMxT0EsSUFBSThTLFFBQVFsYixJQUFJQyxPQUFKLENBQVksUUFBWixDQUFaOztBQUNBLElBQUlGLFNBQVNDLElBQUlDLE9BQUosQ0FBWSxlQUFaLENBQWI7O0FBRUE0RixhQUFhLFVBQVVzVixlQUFWLEVBQTJCO0FBQ3RDLE1BQUk3WCxPQUFPLElBQVg7QUFDQUEsT0FBSzhYLGdCQUFMLEdBQXdCRCxlQUF4QixDQUZzQyxDQUd0Qzs7QUFDQTdYLE9BQUsrWCxxQkFBTCxHQUE2QixFQUE3QjtBQUNELENBTEQ7O0FBT0F4YSxFQUFFK0gsTUFBRixDQUFTL0MsV0FBV3ZFLFNBQXBCLEVBQStCO0FBQzdCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBa0wsU0FBTyxVQUFVcEcsY0FBVixFQUEwQitCLEVBQTFCLEVBQThCbVQsUUFBOUIsRUFBd0NqVyxRQUF4QyxFQUFrRDtBQUN2RCxRQUFJL0IsT0FBTyxJQUFYO0FBRUFpWSxVQUFNblYsY0FBTixFQUFzQm9WLE1BQXRCLEVBSHVELENBSXZEOztBQUNBRCxVQUFNRCxRQUFOLEVBQWdCRSxNQUFoQixFQUx1RCxDQU92RDtBQUNBOztBQUNBLFFBQUkzYSxFQUFFdUQsR0FBRixDQUFNZCxLQUFLK1gscUJBQVgsRUFBa0NDLFFBQWxDLENBQUosRUFBaUQ7QUFDL0NoWSxXQUFLK1gscUJBQUwsQ0FBMkJDLFFBQTNCLEVBQXFDN0ssSUFBckMsQ0FBMENwTCxRQUExQzs7QUFDQTtBQUNEOztBQUVELFFBQUk0SSxZQUFZM0ssS0FBSytYLHFCQUFMLENBQTJCQyxRQUEzQixJQUF1QyxDQUFDalcsUUFBRCxDQUF2RDtBQUVBNlYsVUFBTSxZQUFZO0FBQ2hCLFVBQUk7QUFDRixZQUFJOVYsTUFBTTlCLEtBQUs4WCxnQkFBTCxDQUFzQjlPLE9BQXRCLENBQ1JsRyxjQURRLEVBQ1E7QUFBQ2dDLGVBQUtEO0FBQU4sU0FEUixLQUNzQixJQURoQyxDQURFLENBR0Y7QUFDQTs7QUFDQSxlQUFPLENBQUN0SCxFQUFFbVgsT0FBRixDQUFVL0osU0FBVixDQUFSLEVBQThCO0FBQzVCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsY0FBSXdOLFlBQVlwWixNQUFNZCxLQUFOLENBQVk2RCxHQUFaLENBQWhCO0FBQ0E2SSxvQkFBVWdLLEdBQVYsR0FBZ0IsSUFBaEIsRUFBc0J3RCxTQUF0QjtBQUNEO0FBQ0YsT0FiRCxDQWFFLE9BQU8xVCxDQUFQLEVBQVU7QUFDVixlQUFPLENBQUNsSCxFQUFFbVgsT0FBRixDQUFVL0osU0FBVixDQUFSLEVBQThCO0FBQzVCQSxvQkFBVWdLLEdBQVYsR0FBZ0JsUSxDQUFoQjtBQUNEO0FBQ0YsT0FqQkQsU0FpQlU7QUFDUjtBQUNBO0FBQ0EsZUFBT3pFLEtBQUsrWCxxQkFBTCxDQUEyQkMsUUFBM0IsQ0FBUDtBQUNEO0FBQ0YsS0F2QkQsRUF1QkdJLEdBdkJIO0FBd0JEO0FBbEQ0QixDQUEvQjs7QUFxREF2YixVQUFVMEYsVUFBVixHQUF1QkEsVUFBdkIsQzs7Ozs7Ozs7Ozs7QUMvREFrTix1QkFBdUIsVUFBVTFQLE9BQVYsRUFBbUI7QUFDeEMsTUFBSUMsT0FBTyxJQUFYO0FBRUFBLE9BQUs4SixrQkFBTCxHQUEwQi9KLFFBQVE2SixpQkFBbEM7QUFDQTVKLE9BQUtxWSxZQUFMLEdBQW9CdFksUUFBUTJQLFdBQTVCO0FBQ0ExUCxPQUFLdVYsUUFBTCxHQUFnQnhWLFFBQVFnTCxPQUF4QjtBQUNBL0ssT0FBSzBYLFlBQUwsR0FBb0IzWCxRQUFRc08sV0FBNUI7QUFDQXJPLE9BQUtzWSxjQUFMLEdBQXNCLEVBQXRCO0FBQ0F0WSxPQUFLMFIsUUFBTCxHQUFnQixLQUFoQjtBQUVBMVIsT0FBSytKLGtCQUFMLEdBQTBCL0osS0FBS3FZLFlBQUwsQ0FBa0JwTyx3QkFBbEIsQ0FDeEJqSyxLQUFLOEosa0JBRG1CLENBQTFCLENBVndDLENBYXhDO0FBQ0E7O0FBQ0E5SixPQUFLdVksUUFBTCxHQUFnQixJQUFoQixDQWZ3QyxDQWlCeEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBQ0F2WSxPQUFLd1ksNEJBQUwsR0FBb0MsQ0FBcEM7QUFDQXhZLE9BQUt5WSxjQUFMLEdBQXNCLEVBQXRCLENBekJ3QyxDQXlCZDtBQUUxQjtBQUNBOztBQUNBelksT0FBSzBZLHNCQUFMLEdBQThCbmIsRUFBRW9iLFFBQUYsQ0FDNUIzWSxLQUFLNFksaUNBRHVCLEVBRTVCNVksS0FBSzhKLGtCQUFMLENBQXdCL0osT0FBeEIsQ0FBZ0M4WSxpQkFBaEMsSUFBcUQ7QUFBRztBQUY1QixHQUE5QixDQTdCd0MsQ0FpQ3hDOztBQUNBN1ksT0FBSzhZLFVBQUwsR0FBa0IsSUFBSXhYLE9BQU9vVSxpQkFBWCxFQUFsQjtBQUVBLE1BQUlxRCxrQkFBa0JsSixVQUNwQjdQLEtBQUs4SixrQkFEZSxFQUNLLFVBQVVvSixZQUFWLEVBQXdCO0FBQy9DO0FBQ0E7QUFDQTtBQUNBLFFBQUkxUCxRQUFRQyxVQUFVQyxrQkFBVixDQUE2QkMsR0FBN0IsRUFBWjs7QUFDQSxRQUFJSCxLQUFKLEVBQ0V4RCxLQUFLeVksY0FBTCxDQUFvQnRMLElBQXBCLENBQXlCM0osTUFBTUksVUFBTixFQUF6QixFQU42QyxDQU8vQztBQUNBO0FBQ0E7O0FBQ0EsUUFBSTVELEtBQUt3WSw0QkFBTCxLQUFzQyxDQUExQyxFQUNFeFksS0FBSzBZLHNCQUFMO0FBQ0gsR0FibUIsQ0FBdEI7O0FBZUExWSxPQUFLc1ksY0FBTCxDQUFvQm5MLElBQXBCLENBQXlCLFlBQVk7QUFBRTRMLG9CQUFnQnBXLElBQWhCO0FBQXlCLEdBQWhFLEVBbkR3QyxDQXFEeEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBLE1BQUk1QyxRQUFRa1AscUJBQVosRUFBbUM7QUFDakNqUCxTQUFLaVAscUJBQUwsR0FBNkJsUCxRQUFRa1AscUJBQXJDO0FBQ0QsR0FGRCxNQUVPO0FBQ0wsUUFBSStKLGtCQUNFaFosS0FBSzhKLGtCQUFMLENBQXdCL0osT0FBeEIsQ0FBZ0NrWixpQkFBaEMsSUFDQWpaLEtBQUs4SixrQkFBTCxDQUF3Qi9KLE9BQXhCLENBQWdDbVosZ0JBRGhDLElBQ29EO0FBQ3BELFNBQUssSUFIWDtBQUlBLFFBQUlDLGlCQUFpQjdYLE9BQU84WCxXQUFQLENBQ25CN2IsRUFBRUcsSUFBRixDQUFPc0MsS0FBSzBZLHNCQUFaLEVBQW9DMVksSUFBcEMsQ0FEbUIsRUFDd0JnWixlQUR4QixDQUFyQjs7QUFFQWhaLFNBQUtzWSxjQUFMLENBQW9CbkwsSUFBcEIsQ0FBeUIsWUFBWTtBQUNuQzdMLGFBQU8rWCxhQUFQLENBQXFCRixjQUFyQjtBQUNELEtBRkQ7QUFHRCxHQXhFdUMsQ0EwRXhDOzs7QUFDQW5aLE9BQUs0WSxpQ0FBTDs7QUFFQXhXLFVBQVFnVCxLQUFSLElBQWlCaFQsUUFBUWdULEtBQVIsQ0FBY0MsS0FBZCxDQUFvQkMsbUJBQXBCLENBQ2YsZ0JBRGUsRUFDRyx5QkFESCxFQUM4QixDQUQ5QixDQUFqQjtBQUVELENBL0VEOztBQWlGQS9YLEVBQUUrSCxNQUFGLENBQVNtSyxxQkFBcUJ6UixTQUE5QixFQUF5QztBQUN2QztBQUNBNGEscUNBQW1DLFlBQVk7QUFDN0MsUUFBSTVZLE9BQU8sSUFBWDtBQUNBLFFBQUlBLEtBQUt3WSw0QkFBTCxHQUFvQyxDQUF4QyxFQUNFO0FBQ0YsTUFBRXhZLEtBQUt3WSw0QkFBUDs7QUFDQXhZLFNBQUs4WSxVQUFMLENBQWdCbEMsU0FBaEIsQ0FBMEIsWUFBWTtBQUNwQzVXLFdBQUtzWixVQUFMO0FBQ0QsS0FGRDtBQUdELEdBVnNDO0FBWXZDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQUMsbUJBQWlCLFlBQVc7QUFDMUIsUUFBSXZaLE9BQU8sSUFBWCxDQUQwQixDQUUxQjtBQUNBOztBQUNBLE1BQUVBLEtBQUt3WSw0QkFBUCxDQUowQixDQUsxQjs7QUFDQXhZLFNBQUs4WSxVQUFMLENBQWdCekMsT0FBaEIsQ0FBd0IsWUFBVyxDQUFFLENBQXJDLEVBTjBCLENBUTFCO0FBQ0E7OztBQUNBLFFBQUlyVyxLQUFLd1ksNEJBQUwsS0FBc0MsQ0FBMUMsRUFDRSxNQUFNLElBQUkvVixLQUFKLENBQVUscUNBQ0F6QyxLQUFLd1ksNEJBRGYsQ0FBTjtBQUVILEdBakNzQztBQWtDdkNnQixrQkFBZ0IsWUFBVztBQUN6QixRQUFJeFosT0FBTyxJQUFYLENBRHlCLENBRXpCOztBQUNBLFFBQUlBLEtBQUt3WSw0QkFBTCxLQUFzQyxDQUExQyxFQUNFLE1BQU0sSUFBSS9WLEtBQUosQ0FBVSxxQ0FDQXpDLEtBQUt3WSw0QkFEZixDQUFOLENBSnVCLENBTXpCO0FBQ0E7O0FBQ0F4WSxTQUFLOFksVUFBTCxDQUFnQnpDLE9BQWhCLENBQXdCLFlBQVk7QUFDbENyVyxXQUFLc1osVUFBTDtBQUNELEtBRkQ7QUFHRCxHQTdDc0M7QUErQ3ZDQSxjQUFZLFlBQVk7QUFDdEIsUUFBSXRaLE9BQU8sSUFBWDtBQUNBLE1BQUVBLEtBQUt3WSw0QkFBUDtBQUVBLFFBQUl4WSxLQUFLMFIsUUFBVCxFQUNFO0FBRUYsUUFBSStILFFBQVEsS0FBWjtBQUNBLFFBQUlDLFVBQUo7QUFDQSxRQUFJQyxhQUFhM1osS0FBS3VZLFFBQXRCOztBQUNBLFFBQUksQ0FBQ29CLFVBQUwsRUFBaUI7QUFDZkYsY0FBUSxJQUFSLENBRGUsQ0FFZjs7QUFDQUUsbUJBQWEzWixLQUFLdVYsUUFBTCxHQUFnQixFQUFoQixHQUFxQixJQUFJNVEsZ0JBQWdCaUksTUFBcEIsRUFBbEM7QUFDRDs7QUFFRDVNLFNBQUtpUCxxQkFBTCxJQUE4QmpQLEtBQUtpUCxxQkFBTCxFQUE5QixDQWhCc0IsQ0FrQnRCOztBQUNBLFFBQUkySyxpQkFBaUI1WixLQUFLeVksY0FBMUI7QUFDQXpZLFNBQUt5WSxjQUFMLEdBQXNCLEVBQXRCLENBcEJzQixDQXNCdEI7O0FBQ0EsUUFBSTtBQUNGaUIsbUJBQWExWixLQUFLK0osa0JBQUwsQ0FBd0J1RCxhQUF4QixDQUFzQ3ROLEtBQUt1VixRQUEzQyxDQUFiO0FBQ0QsS0FGRCxDQUVFLE9BQU85USxDQUFQLEVBQVU7QUFDVixVQUFJZ1YsU0FBUyxPQUFPaFYsRUFBRW9WLElBQVQsS0FBbUIsUUFBaEMsRUFBMEM7QUFDeEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBN1osYUFBSzBYLFlBQUwsQ0FBa0JiLFVBQWxCLENBQ0UsSUFBSXBVLEtBQUosQ0FDRSxtQ0FDRXNTLEtBQUszRyxTQUFMLENBQWVwTyxLQUFLOEosa0JBQXBCLENBREYsR0FDNEMsSUFENUMsR0FDbURyRixFQUFFcVYsT0FGdkQsQ0FERjs7QUFJQTtBQUNELE9BWlMsQ0FjVjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBQyxZQUFNL2IsU0FBTixDQUFnQm1QLElBQWhCLENBQXFCeEUsS0FBckIsQ0FBMkIzSSxLQUFLeVksY0FBaEMsRUFBZ0RtQixjQUFoRDs7QUFDQXRZLGFBQU82UixNQUFQLENBQWMsbUNBQ0E0QixLQUFLM0csU0FBTCxDQUFlcE8sS0FBSzhKLGtCQUFwQixDQURBLEdBQzBDLElBRDFDLEdBQ2lEckYsRUFBRTJPLEtBRGpFOztBQUVBO0FBQ0QsS0FqRHFCLENBbUR0Qjs7O0FBQ0EsUUFBSSxDQUFDcFQsS0FBSzBSLFFBQVYsRUFBb0I7QUFDbEIvTSxzQkFBZ0JxVixpQkFBaEIsQ0FDRWhhLEtBQUt1VixRQURQLEVBQ2lCb0UsVUFEakIsRUFDNkJELFVBRDdCLEVBQ3lDMVosS0FBSzBYLFlBRDlDO0FBRUQsS0F2RHFCLENBeUR0QjtBQUNBO0FBQ0E7OztBQUNBLFFBQUkrQixLQUFKLEVBQ0V6WixLQUFLMFgsWUFBTCxDQUFrQmYsS0FBbEIsR0E3RG9CLENBK0R0QjtBQUNBO0FBQ0E7O0FBQ0EzVyxTQUFLdVksUUFBTCxHQUFnQm1CLFVBQWhCLENBbEVzQixDQW9FdEI7QUFDQTtBQUNBO0FBQ0E7O0FBQ0ExWixTQUFLMFgsWUFBTCxDQUFrQlgsT0FBbEIsQ0FBMEIsWUFBWTtBQUNwQ3haLFFBQUVLLElBQUYsQ0FBT2djLGNBQVAsRUFBdUIsVUFBVUssQ0FBVixFQUFhO0FBQ2xDQSxVQUFFcFcsU0FBRjtBQUNELE9BRkQ7QUFHRCxLQUpEO0FBS0QsR0E1SHNDO0FBOEh2Q2xCLFFBQU0sWUFBWTtBQUNoQixRQUFJM0MsT0FBTyxJQUFYO0FBQ0FBLFNBQUswUixRQUFMLEdBQWdCLElBQWhCOztBQUNBblUsTUFBRUssSUFBRixDQUFPb0MsS0FBS3NZLGNBQVosRUFBNEIsVUFBVTRCLENBQVYsRUFBYTtBQUFFQTtBQUFNLEtBQWpELEVBSGdCLENBSWhCOzs7QUFDQTNjLE1BQUVLLElBQUYsQ0FBT29DLEtBQUt5WSxjQUFaLEVBQTRCLFVBQVV3QixDQUFWLEVBQWE7QUFDdkNBLFFBQUVwVyxTQUFGO0FBQ0QsS0FGRDs7QUFHQXpCLFlBQVFnVCxLQUFSLElBQWlCaFQsUUFBUWdULEtBQVIsQ0FBY0MsS0FBZCxDQUFvQkMsbUJBQXBCLENBQ2YsZ0JBRGUsRUFDRyx5QkFESCxFQUM4QixDQUFDLENBRC9CLENBQWpCO0FBRUQ7QUF4SXNDLENBQXpDLEU7Ozs7Ozs7Ozs7O0FDakZBLElBQUk3WSxTQUFTQyxJQUFJQyxPQUFKLENBQVksZUFBWixDQUFiOztBQUVBLElBQUl3ZCxRQUFRO0FBQ1ZDLFlBQVUsVUFEQTtBQUVWQyxZQUFVLFVBRkE7QUFHVkMsVUFBUTtBQUhFLENBQVosQyxDQU1BO0FBQ0E7O0FBQ0EsSUFBSUMsa0JBQWtCLFlBQVksQ0FBRSxDQUFwQzs7QUFDQSxJQUFJQywwQkFBMEIsVUFBVWpMLENBQVYsRUFBYTtBQUN6QyxTQUFPLFlBQVk7QUFDakIsUUFBSTtBQUNGQSxRQUFFNUcsS0FBRixDQUFRLElBQVIsRUFBY0MsU0FBZDtBQUNELEtBRkQsQ0FFRSxPQUFPbkUsQ0FBUCxFQUFVO0FBQ1YsVUFBSSxFQUFFQSxhQUFhOFYsZUFBZixDQUFKLEVBQ0UsTUFBTTlWLENBQU47QUFDSDtBQUNGLEdBUEQ7QUFRRCxDQVREOztBQVdBLElBQUlnVyxZQUFZLENBQWhCLEMsQ0FFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUNBckwscUJBQXFCLFVBQVVyUCxPQUFWLEVBQW1CO0FBQ3RDLE1BQUlDLE9BQU8sSUFBWDtBQUNBQSxPQUFLMGEsVUFBTCxHQUFrQixJQUFsQixDQUZzQyxDQUViOztBQUV6QjFhLE9BQUs4RSxHQUFMLEdBQVcyVixTQUFYO0FBQ0FBO0FBRUF6YSxPQUFLOEosa0JBQUwsR0FBMEIvSixRQUFRNkosaUJBQWxDO0FBQ0E1SixPQUFLcVksWUFBTCxHQUFvQnRZLFFBQVEyUCxXQUE1QjtBQUNBMVAsT0FBSzBYLFlBQUwsR0FBb0IzWCxRQUFRc08sV0FBNUI7O0FBRUEsTUFBSXRPLFFBQVFnTCxPQUFaLEVBQXFCO0FBQ25CLFVBQU10SSxNQUFNLDJEQUFOLENBQU47QUFDRDs7QUFFRCxNQUFJcU0sU0FBUy9PLFFBQVErTyxNQUFyQixDQWZzQyxDQWdCdEM7QUFDQTs7QUFDQSxNQUFJNkwsYUFBYTdMLFVBQVVBLE9BQU84TCxhQUFQLEVBQTNCOztBQUVBLE1BQUk3YSxRQUFRNkosaUJBQVIsQ0FBMEI3SixPQUExQixDQUFrQ2tKLEtBQXRDLEVBQTZDO0FBQzNDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFFQSxRQUFJNFIsY0FBYztBQUFFQyxhQUFPblcsZ0JBQWdCaUk7QUFBekIsS0FBbEI7QUFDQTVNLFNBQUsrYSxNQUFMLEdBQWMvYSxLQUFLOEosa0JBQUwsQ0FBd0IvSixPQUF4QixDQUFnQ2tKLEtBQTlDO0FBQ0FqSixTQUFLZ2IsV0FBTCxHQUFtQkwsVUFBbkI7QUFDQTNhLFNBQUtpYixPQUFMLEdBQWVuTSxNQUFmO0FBQ0E5TyxTQUFLa2Isa0JBQUwsR0FBMEIsSUFBSUMsVUFBSixDQUFlUixVQUFmLEVBQTJCRSxXQUEzQixDQUExQixDQWQyQyxDQWUzQzs7QUFDQTdhLFNBQUtvYixVQUFMLEdBQWtCLElBQUlDLE9BQUosQ0FBWVYsVUFBWixFQUF3QkUsV0FBeEIsQ0FBbEI7QUFDRCxHQWpCRCxNQWlCTztBQUNMN2EsU0FBSythLE1BQUwsR0FBYyxDQUFkO0FBQ0EvYSxTQUFLZ2IsV0FBTCxHQUFtQixJQUFuQjtBQUNBaGIsU0FBS2liLE9BQUwsR0FBZSxJQUFmO0FBQ0FqYixTQUFLa2Isa0JBQUwsR0FBMEIsSUFBMUI7QUFDQWxiLFNBQUtvYixVQUFMLEdBQWtCLElBQUl6VyxnQkFBZ0JpSSxNQUFwQixFQUFsQjtBQUNELEdBM0NxQyxDQTZDdEM7QUFDQTtBQUNBOzs7QUFDQTVNLE9BQUtzYixtQkFBTCxHQUEyQixLQUEzQjtBQUVBdGIsT0FBSzBSLFFBQUwsR0FBZ0IsS0FBaEI7QUFDQTFSLE9BQUt1YixZQUFMLEdBQW9CLEVBQXBCO0FBRUFuWixVQUFRZ1QsS0FBUixJQUFpQmhULFFBQVFnVCxLQUFSLENBQWNDLEtBQWQsQ0FBb0JDLG1CQUFwQixDQUNmLGdCQURlLEVBQ0csdUJBREgsRUFDNEIsQ0FENUIsQ0FBakI7O0FBR0F0VixPQUFLd2Isb0JBQUwsQ0FBMEJyQixNQUFNQyxRQUFoQzs7QUFFQXBhLE9BQUt5YixRQUFMLEdBQWdCMWIsUUFBUThPLE9BQXhCO0FBQ0EsTUFBSTZNLGFBQWExYixLQUFLOEosa0JBQUwsQ0FBd0IvSixPQUF4QixDQUFnQytMLE1BQWhDLElBQTBDLEVBQTNEO0FBQ0E5TCxPQUFLMmIsYUFBTCxHQUFxQmhYLGdCQUFnQmlYLGtCQUFoQixDQUFtQ0YsVUFBbkMsQ0FBckIsQ0E1RHNDLENBNkR0QztBQUNBOztBQUNBMWIsT0FBSzZiLGlCQUFMLEdBQXlCN2IsS0FBS3liLFFBQUwsQ0FBY0sscUJBQWQsQ0FBb0NKLFVBQXBDLENBQXpCO0FBQ0EsTUFBSTVNLE1BQUosRUFDRTlPLEtBQUs2YixpQkFBTCxHQUF5Qi9NLE9BQU9nTixxQkFBUCxDQUE2QjliLEtBQUs2YixpQkFBbEMsQ0FBekI7QUFDRjdiLE9BQUsrYixtQkFBTCxHQUEyQnBYLGdCQUFnQmlYLGtCQUFoQixDQUN6QjViLEtBQUs2YixpQkFEb0IsQ0FBM0I7QUFHQTdiLE9BQUtnYyxZQUFMLEdBQW9CLElBQUlyWCxnQkFBZ0JpSSxNQUFwQixFQUFwQjtBQUNBNU0sT0FBS2ljLGtCQUFMLEdBQTBCLElBQTFCO0FBQ0FqYyxPQUFLa2MsZ0JBQUwsR0FBd0IsQ0FBeEI7QUFFQWxjLE9BQUttYyx5QkFBTCxHQUFpQyxLQUFqQztBQUNBbmMsT0FBS29jLGdDQUFMLEdBQXdDLEVBQXhDLENBMUVzQyxDQTRFdEM7QUFDQTs7QUFDQXBjLE9BQUt1YixZQUFMLENBQWtCcE8sSUFBbEIsQ0FBdUJuTixLQUFLcVksWUFBTCxDQUFrQm5YLFlBQWxCLENBQStCb1MsZ0JBQS9CLENBQ3JCa0gsd0JBQXdCLFlBQVk7QUFDbEN4YSxTQUFLcWMsZ0JBQUw7QUFDRCxHQUZELENBRHFCLENBQXZCOztBQU1Bck0saUJBQWVoUSxLQUFLOEosa0JBQXBCLEVBQXdDLFVBQVVtRyxPQUFWLEVBQW1CO0FBQ3pEalEsU0FBS3ViLFlBQUwsQ0FBa0JwTyxJQUFsQixDQUF1Qm5OLEtBQUtxWSxZQUFMLENBQWtCblgsWUFBbEIsQ0FBK0I4UixZQUEvQixDQUNyQi9DLE9BRHFCLEVBQ1osVUFBVWlELFlBQVYsRUFBd0I7QUFDL0I1UixhQUFPa04sZ0JBQVAsQ0FBd0JnTSx3QkFBd0IsWUFBWTtBQUMxRCxZQUFJdEosS0FBS2dDLGFBQWFoQyxFQUF0Qjs7QUFDQSxZQUFJZ0MsYUFBYW5OLGNBQWIsSUFBK0JtTixhQUFhaE4sWUFBaEQsRUFBOEQ7QUFDNUQ7QUFDQTtBQUNBO0FBQ0FsRyxlQUFLcWMsZ0JBQUw7QUFDRCxTQUxELE1BS087QUFDTDtBQUNBLGNBQUlyYyxLQUFLc2MsTUFBTCxLQUFnQm5DLE1BQU1DLFFBQTFCLEVBQW9DO0FBQ2xDcGEsaUJBQUt1Yyx5QkFBTCxDQUErQnJMLEVBQS9CO0FBQ0QsV0FGRCxNQUVPO0FBQ0xsUixpQkFBS3djLGlDQUFMLENBQXVDdEwsRUFBdkM7QUFDRDtBQUNGO0FBQ0YsT0FmdUIsQ0FBeEI7QUFnQkQsS0FsQm9CLENBQXZCO0FBb0JELEdBckJELEVBcEZzQyxDQTJHdEM7O0FBQ0FsUixPQUFLdWIsWUFBTCxDQUFrQnBPLElBQWxCLENBQXVCMEMsVUFDckI3UCxLQUFLOEosa0JBRGdCLEVBQ0ksVUFBVW9KLFlBQVYsRUFBd0I7QUFDL0M7QUFDQSxRQUFJMVAsUUFBUUMsVUFBVUMsa0JBQVYsQ0FBNkJDLEdBQTdCLEVBQVo7O0FBQ0EsUUFBSSxDQUFDSCxLQUFELElBQVVBLE1BQU1pWixLQUFwQixFQUNFOztBQUVGLFFBQUlqWixNQUFNa1osb0JBQVYsRUFBZ0M7QUFDOUJsWixZQUFNa1osb0JBQU4sQ0FBMkIxYyxLQUFLOEUsR0FBaEMsSUFBdUM5RSxJQUF2QztBQUNBO0FBQ0Q7O0FBRUR3RCxVQUFNa1osb0JBQU4sR0FBNkIsRUFBN0I7QUFDQWxaLFVBQU1rWixvQkFBTixDQUEyQjFjLEtBQUs4RSxHQUFoQyxJQUF1QzlFLElBQXZDO0FBRUF3RCxVQUFNbVosWUFBTixDQUFtQixZQUFZO0FBQzdCLFVBQUlDLFVBQVVwWixNQUFNa1osb0JBQXBCO0FBQ0EsYUFBT2xaLE1BQU1rWixvQkFBYixDQUY2QixDQUk3QjtBQUNBOztBQUNBMWMsV0FBS3FZLFlBQUwsQ0FBa0JuWCxZQUFsQixDQUErQnFTLGlCQUEvQjs7QUFFQWhXLFFBQUVLLElBQUYsQ0FBT2dmLE9BQVAsRUFBZ0IsVUFBVUMsTUFBVixFQUFrQjtBQUNoQyxZQUFJQSxPQUFPbkwsUUFBWCxFQUNFO0FBRUYsWUFBSXpOLFFBQVFULE1BQU1JLFVBQU4sRUFBWjs7QUFDQSxZQUFJaVosT0FBT1AsTUFBUCxLQUFrQm5DLE1BQU1HLE1BQTVCLEVBQW9DO0FBQ2xDO0FBQ0E7QUFDQTtBQUNBdUMsaUJBQU9uRixZQUFQLENBQW9CWCxPQUFwQixDQUE0QixZQUFZO0FBQ3RDOVMsa0JBQU1KLFNBQU47QUFDRCxXQUZEO0FBR0QsU0FQRCxNQU9PO0FBQ0xnWixpQkFBT1QsZ0NBQVAsQ0FBd0NqUCxJQUF4QyxDQUE2Q2xKLEtBQTdDO0FBQ0Q7QUFDRixPQWZEO0FBZ0JELEtBeEJEO0FBeUJELEdBeENvQixDQUF2QixFQTVHc0MsQ0F1SnRDO0FBQ0E7OztBQUNBakUsT0FBS3ViLFlBQUwsQ0FBa0JwTyxJQUFsQixDQUF1Qm5OLEtBQUtxWSxZQUFMLENBQWtCdlUsV0FBbEIsQ0FBOEIwVyx3QkFDbkQsWUFBWTtBQUNWeGEsU0FBS3FjLGdCQUFMO0FBQ0QsR0FIa0QsQ0FBOUIsQ0FBdkIsRUF6SnNDLENBOEp0QztBQUNBOzs7QUFDQS9hLFNBQU8yTSxLQUFQLENBQWF1TSx3QkFBd0IsWUFBWTtBQUMvQ3hhLFNBQUs4YyxnQkFBTDtBQUNELEdBRlksQ0FBYjtBQUdELENBbktEOztBQXFLQXZmLEVBQUUrSCxNQUFGLENBQVM4SixtQkFBbUJwUixTQUE1QixFQUF1QztBQUNyQytlLGlCQUFlLFVBQVVsWSxFQUFWLEVBQWMvQyxHQUFkLEVBQW1CO0FBQ2hDLFFBQUk5QixPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxVQUFJMUMsU0FBU3ZPLEVBQUVVLEtBQUYsQ0FBUTZELEdBQVIsQ0FBYjs7QUFDQSxhQUFPZ0ssT0FBT2hILEdBQWQ7O0FBQ0E5RSxXQUFLb2IsVUFBTCxDQUFnQnRPLEdBQWhCLENBQW9CakksRUFBcEIsRUFBd0I3RSxLQUFLK2IsbUJBQUwsQ0FBeUJqYSxHQUF6QixDQUF4Qjs7QUFDQTlCLFdBQUswWCxZQUFMLENBQWtCbkgsS0FBbEIsQ0FBd0IxTCxFQUF4QixFQUE0QjdFLEtBQUsyYixhQUFMLENBQW1CN1AsTUFBbkIsQ0FBNUIsRUFKa0MsQ0FNbEM7QUFDQTtBQUNBO0FBQ0E7OztBQUNBLFVBQUk5TCxLQUFLK2EsTUFBTCxJQUFlL2EsS0FBS29iLFVBQUwsQ0FBZ0J0YyxJQUFoQixLQUF5QmtCLEtBQUsrYSxNQUFqRCxFQUF5RDtBQUN2RDtBQUNBLFlBQUkvYSxLQUFLb2IsVUFBTCxDQUFnQnRjLElBQWhCLE9BQTJCa0IsS0FBSythLE1BQUwsR0FBYyxDQUE3QyxFQUFnRDtBQUM5QyxnQkFBTSxJQUFJdFksS0FBSixDQUFVLGlDQUNDekMsS0FBS29iLFVBQUwsQ0FBZ0J0YyxJQUFoQixLQUF5QmtCLEtBQUsrYSxNQUQvQixJQUVBLG9DQUZWLENBQU47QUFHRDs7QUFFRCxZQUFJaUMsbUJBQW1CaGQsS0FBS29iLFVBQUwsQ0FBZ0I2QixZQUFoQixFQUF2Qjs7QUFDQSxZQUFJQyxpQkFBaUJsZCxLQUFLb2IsVUFBTCxDQUFnQnpYLEdBQWhCLENBQW9CcVosZ0JBQXBCLENBQXJCOztBQUVBLFlBQUlqZSxNQUFNb2UsTUFBTixDQUFhSCxnQkFBYixFQUErQm5ZLEVBQS9CLENBQUosRUFBd0M7QUFDdEMsZ0JBQU0sSUFBSXBDLEtBQUosQ0FBVSwwREFBVixDQUFOO0FBQ0Q7O0FBRUR6QyxhQUFLb2IsVUFBTCxDQUFnQnhWLE1BQWhCLENBQXVCb1gsZ0JBQXZCOztBQUNBaGQsYUFBSzBYLFlBQUwsQ0FBa0IwRixPQUFsQixDQUEwQkosZ0JBQTFCOztBQUNBaGQsYUFBS3FkLFlBQUwsQ0FBa0JMLGdCQUFsQixFQUFvQ0UsY0FBcEM7QUFDRDtBQUNGLEtBN0JEO0FBOEJELEdBakNvQztBQWtDckNJLG9CQUFrQixVQUFVelksRUFBVixFQUFjO0FBQzlCLFFBQUk3RSxPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQ3hPLFdBQUtvYixVQUFMLENBQWdCeFYsTUFBaEIsQ0FBdUJmLEVBQXZCOztBQUNBN0UsV0FBSzBYLFlBQUwsQ0FBa0IwRixPQUFsQixDQUEwQnZZLEVBQTFCOztBQUNBLFVBQUksQ0FBRTdFLEtBQUsrYSxNQUFQLElBQWlCL2EsS0FBS29iLFVBQUwsQ0FBZ0J0YyxJQUFoQixPQUEyQmtCLEtBQUsrYSxNQUFyRCxFQUNFO0FBRUYsVUFBSS9hLEtBQUtvYixVQUFMLENBQWdCdGMsSUFBaEIsS0FBeUJrQixLQUFLK2EsTUFBbEMsRUFDRSxNQUFNdFksTUFBTSw2QkFBTixDQUFOLENBUGdDLENBU2xDO0FBQ0E7O0FBRUEsVUFBSSxDQUFDekMsS0FBS2tiLGtCQUFMLENBQXdCcUMsS0FBeEIsRUFBTCxFQUFzQztBQUNwQztBQUNBO0FBQ0EsWUFBSUMsV0FBV3hkLEtBQUtrYixrQkFBTCxDQUF3QnVDLFlBQXhCLEVBQWY7O0FBQ0EsWUFBSXpXLFNBQVNoSCxLQUFLa2Isa0JBQUwsQ0FBd0J2WCxHQUF4QixDQUE0QjZaLFFBQTVCLENBQWI7O0FBQ0F4ZCxhQUFLMGQsZUFBTCxDQUFxQkYsUUFBckI7O0FBQ0F4ZCxhQUFLK2MsYUFBTCxDQUFtQlMsUUFBbkIsRUFBNkJ4VyxNQUE3Qjs7QUFDQTtBQUNELE9BcEJpQyxDQXNCbEM7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxVQUFJaEgsS0FBS3NjLE1BQUwsS0FBZ0JuQyxNQUFNQyxRQUExQixFQUNFLE9BOUJnQyxDQWdDbEM7QUFDQTtBQUNBO0FBQ0E7O0FBQ0EsVUFBSXBhLEtBQUtzYixtQkFBVCxFQUNFLE9BckNnQyxDQXVDbEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBLFlBQU0sSUFBSTdZLEtBQUosQ0FBVSwyQkFBVixDQUFOO0FBQ0QsS0EvQ0Q7QUFnREQsR0FwRm9DO0FBcUZyQ2tiLG9CQUFrQixVQUFVOVksRUFBVixFQUFjK1ksTUFBZCxFQUFzQjVXLE1BQXRCLEVBQThCO0FBQzlDLFFBQUloSCxPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQ3hPLFdBQUtvYixVQUFMLENBQWdCdE8sR0FBaEIsQ0FBb0JqSSxFQUFwQixFQUF3QjdFLEtBQUsrYixtQkFBTCxDQUF5Qi9VLE1BQXpCLENBQXhCOztBQUNBLFVBQUk2VyxlQUFlN2QsS0FBSzJiLGFBQUwsQ0FBbUIzVSxNQUFuQixDQUFuQjs7QUFDQSxVQUFJOFcsZUFBZTlkLEtBQUsyYixhQUFMLENBQW1CaUMsTUFBbkIsQ0FBbkI7O0FBQ0EsVUFBSUcsVUFBVUMsYUFBYUMsaUJBQWIsQ0FDWkosWUFEWSxFQUNFQyxZQURGLENBQWQ7QUFFQSxVQUFJLENBQUN2Z0IsRUFBRW1YLE9BQUYsQ0FBVXFKLE9BQVYsQ0FBTCxFQUNFL2QsS0FBSzBYLFlBQUwsQ0FBa0JxRyxPQUFsQixDQUEwQmxaLEVBQTFCLEVBQThCa1osT0FBOUI7QUFDSCxLQVJEO0FBU0QsR0FoR29DO0FBaUdyQ1YsZ0JBQWMsVUFBVXhZLEVBQVYsRUFBYy9DLEdBQWQsRUFBbUI7QUFDL0IsUUFBSTlCLE9BQU8sSUFBWDs7QUFDQXNCLFdBQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ2xDeE8sV0FBS2tiLGtCQUFMLENBQXdCcE8sR0FBeEIsQ0FBNEJqSSxFQUE1QixFQUFnQzdFLEtBQUsrYixtQkFBTCxDQUF5QmphLEdBQXpCLENBQWhDLEVBRGtDLENBR2xDOzs7QUFDQSxVQUFJOUIsS0FBS2tiLGtCQUFMLENBQXdCcGMsSUFBeEIsS0FBaUNrQixLQUFLK2EsTUFBMUMsRUFBa0Q7QUFDaEQsWUFBSW1ELGdCQUFnQmxlLEtBQUtrYixrQkFBTCxDQUF3QitCLFlBQXhCLEVBQXBCOztBQUVBamQsYUFBS2tiLGtCQUFMLENBQXdCdFYsTUFBeEIsQ0FBK0JzWSxhQUEvQixFQUhnRCxDQUtoRDtBQUNBOzs7QUFDQWxlLGFBQUtzYixtQkFBTCxHQUEyQixLQUEzQjtBQUNEO0FBQ0YsS0FiRDtBQWNELEdBakhvQztBQWtIckM7QUFDQTtBQUNBb0MsbUJBQWlCLFVBQVU3WSxFQUFWLEVBQWM7QUFDN0IsUUFBSTdFLE9BQU8sSUFBWDs7QUFDQXNCLFdBQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ2xDeE8sV0FBS2tiLGtCQUFMLENBQXdCdFYsTUFBeEIsQ0FBK0JmLEVBQS9CLEVBRGtDLENBRWxDO0FBQ0E7QUFDQTs7O0FBQ0EsVUFBSSxDQUFFN0UsS0FBS2tiLGtCQUFMLENBQXdCcGMsSUFBeEIsRUFBRixJQUFvQyxDQUFFa0IsS0FBS3NiLG1CQUEvQyxFQUNFdGIsS0FBS3FjLGdCQUFMO0FBQ0gsS0FQRDtBQVFELEdBOUhvQztBQStIckM7QUFDQTtBQUNBO0FBQ0E4QixnQkFBYyxVQUFVcmMsR0FBVixFQUFlO0FBQzNCLFFBQUk5QixPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxVQUFJM0osS0FBSy9DLElBQUlnRCxHQUFiO0FBQ0EsVUFBSTlFLEtBQUtvYixVQUFMLENBQWdCdGEsR0FBaEIsQ0FBb0IrRCxFQUFwQixDQUFKLEVBQ0UsTUFBTXBDLE1BQU0sOENBQThDb0MsRUFBcEQsQ0FBTjtBQUNGLFVBQUk3RSxLQUFLK2EsTUFBTCxJQUFlL2EsS0FBS2tiLGtCQUFMLENBQXdCcGEsR0FBeEIsQ0FBNEIrRCxFQUE1QixDQUFuQixFQUNFLE1BQU1wQyxNQUFNLHNEQUFzRG9DLEVBQTVELENBQU47QUFFRixVQUFJb0UsUUFBUWpKLEtBQUsrYSxNQUFqQjtBQUNBLFVBQUlKLGFBQWEzYSxLQUFLZ2IsV0FBdEI7QUFDQSxVQUFJb0QsZUFBZ0JuVixTQUFTakosS0FBS29iLFVBQUwsQ0FBZ0J0YyxJQUFoQixLQUF5QixDQUFuQyxHQUNqQmtCLEtBQUtvYixVQUFMLENBQWdCelgsR0FBaEIsQ0FBb0IzRCxLQUFLb2IsVUFBTCxDQUFnQjZCLFlBQWhCLEVBQXBCLENBRGlCLEdBQ3FDLElBRHhEO0FBRUEsVUFBSW9CLGNBQWVwVixTQUFTakosS0FBS2tiLGtCQUFMLENBQXdCcGMsSUFBeEIsS0FBaUMsQ0FBM0MsR0FDZGtCLEtBQUtrYixrQkFBTCxDQUF3QnZYLEdBQXhCLENBQTRCM0QsS0FBS2tiLGtCQUFMLENBQXdCK0IsWUFBeEIsRUFBNUIsQ0FEYyxHQUVkLElBRkosQ0FYa0MsQ0FjbEM7QUFDQTtBQUNBOztBQUNBLFVBQUlxQixZQUFZLENBQUVyVixLQUFGLElBQVdqSixLQUFLb2IsVUFBTCxDQUFnQnRjLElBQWhCLEtBQXlCbUssS0FBcEMsSUFDZDBSLFdBQVc3WSxHQUFYLEVBQWdCc2MsWUFBaEIsSUFBZ0MsQ0FEbEMsQ0FqQmtDLENBb0JsQztBQUNBO0FBQ0E7O0FBQ0EsVUFBSUcsb0JBQW9CLENBQUNELFNBQUQsSUFBY3RlLEtBQUtzYixtQkFBbkIsSUFDdEJ0YixLQUFLa2Isa0JBQUwsQ0FBd0JwYyxJQUF4QixLQUFpQ21LLEtBRG5DLENBdkJrQyxDQTBCbEM7QUFDQTs7QUFDQSxVQUFJdVYsc0JBQXNCLENBQUNGLFNBQUQsSUFBY0QsV0FBZCxJQUN4QjFELFdBQVc3WSxHQUFYLEVBQWdCdWMsV0FBaEIsS0FBZ0MsQ0FEbEM7QUFHQSxVQUFJSSxXQUFXRixxQkFBcUJDLG1CQUFwQzs7QUFFQSxVQUFJRixTQUFKLEVBQWU7QUFDYnRlLGFBQUsrYyxhQUFMLENBQW1CbFksRUFBbkIsRUFBdUIvQyxHQUF2QjtBQUNELE9BRkQsTUFFTyxJQUFJMmMsUUFBSixFQUFjO0FBQ25CemUsYUFBS3FkLFlBQUwsQ0FBa0J4WSxFQUFsQixFQUFzQi9DLEdBQXRCO0FBQ0QsT0FGTSxNQUVBO0FBQ0w7QUFDQTlCLGFBQUtzYixtQkFBTCxHQUEyQixLQUEzQjtBQUNEO0FBQ0YsS0F6Q0Q7QUEwQ0QsR0E5S29DO0FBK0tyQztBQUNBO0FBQ0E7QUFDQW9ELG1CQUFpQixVQUFVN1osRUFBVixFQUFjO0FBQzdCLFFBQUk3RSxPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxVQUFJLENBQUV4TyxLQUFLb2IsVUFBTCxDQUFnQnRhLEdBQWhCLENBQW9CK0QsRUFBcEIsQ0FBRixJQUE2QixDQUFFN0UsS0FBSythLE1BQXhDLEVBQ0UsTUFBTXRZLE1BQU0sdURBQXVEb0MsRUFBN0QsQ0FBTjs7QUFFRixVQUFJN0UsS0FBS29iLFVBQUwsQ0FBZ0J0YSxHQUFoQixDQUFvQitELEVBQXBCLENBQUosRUFBNkI7QUFDM0I3RSxhQUFLc2QsZ0JBQUwsQ0FBc0J6WSxFQUF0QjtBQUNELE9BRkQsTUFFTyxJQUFJN0UsS0FBS2tiLGtCQUFMLENBQXdCcGEsR0FBeEIsQ0FBNEIrRCxFQUE1QixDQUFKLEVBQXFDO0FBQzFDN0UsYUFBSzBkLGVBQUwsQ0FBcUI3WSxFQUFyQjtBQUNEO0FBQ0YsS0FURDtBQVVELEdBOUxvQztBQStMckM4WixjQUFZLFVBQVU5WixFQUFWLEVBQWNtQyxNQUFkLEVBQXNCO0FBQ2hDLFFBQUloSCxPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQyxVQUFJb1EsYUFBYTVYLFVBQVVoSCxLQUFLeWIsUUFBTCxDQUFjb0QsZUFBZCxDQUE4QjdYLE1BQTlCLEVBQXNDN0MsTUFBakU7O0FBRUEsVUFBSTJhLGtCQUFrQjllLEtBQUtvYixVQUFMLENBQWdCdGEsR0FBaEIsQ0FBb0IrRCxFQUFwQixDQUF0Qjs7QUFDQSxVQUFJa2EsaUJBQWlCL2UsS0FBSythLE1BQUwsSUFBZS9hLEtBQUtrYixrQkFBTCxDQUF3QnBhLEdBQXhCLENBQTRCK0QsRUFBNUIsQ0FBcEM7O0FBQ0EsVUFBSW1hLGVBQWVGLG1CQUFtQkMsY0FBdEM7O0FBRUEsVUFBSUgsY0FBYyxDQUFDSSxZQUFuQixFQUFpQztBQUMvQmhmLGFBQUttZSxZQUFMLENBQWtCblgsTUFBbEI7QUFDRCxPQUZELE1BRU8sSUFBSWdZLGdCQUFnQixDQUFDSixVQUFyQixFQUFpQztBQUN0QzVlLGFBQUswZSxlQUFMLENBQXFCN1osRUFBckI7QUFDRCxPQUZNLE1BRUEsSUFBSW1hLGdCQUFnQkosVUFBcEIsRUFBZ0M7QUFDckMsWUFBSWhCLFNBQVM1ZCxLQUFLb2IsVUFBTCxDQUFnQnpYLEdBQWhCLENBQW9Ca0IsRUFBcEIsQ0FBYjs7QUFDQSxZQUFJOFYsYUFBYTNhLEtBQUtnYixXQUF0Qjs7QUFDQSxZQUFJaUUsY0FBY2pmLEtBQUsrYSxNQUFMLElBQWUvYSxLQUFLa2Isa0JBQUwsQ0FBd0JwYyxJQUF4QixFQUFmLElBQ2hCa0IsS0FBS2tiLGtCQUFMLENBQXdCdlgsR0FBeEIsQ0FBNEIzRCxLQUFLa2Isa0JBQUwsQ0FBd0J1QyxZQUF4QixFQUE1QixDQURGOztBQUVBLFlBQUlZLFdBQUo7O0FBRUEsWUFBSVMsZUFBSixFQUFxQjtBQUNuQjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxjQUFJSSxtQkFBbUIsQ0FBRWxmLEtBQUsrYSxNQUFQLElBQ3JCL2EsS0FBS2tiLGtCQUFMLENBQXdCcGMsSUFBeEIsT0FBbUMsQ0FEZCxJQUVyQjZiLFdBQVczVCxNQUFYLEVBQW1CaVksV0FBbkIsS0FBbUMsQ0FGckM7O0FBSUEsY0FBSUMsZ0JBQUosRUFBc0I7QUFDcEJsZixpQkFBSzJkLGdCQUFMLENBQXNCOVksRUFBdEIsRUFBMEIrWSxNQUExQixFQUFrQzVXLE1BQWxDO0FBQ0QsV0FGRCxNQUVPO0FBQ0w7QUFDQWhILGlCQUFLc2QsZ0JBQUwsQ0FBc0J6WSxFQUF0QixFQUZLLENBR0w7OztBQUNBd1osMEJBQWNyZSxLQUFLa2Isa0JBQUwsQ0FBd0J2WCxHQUF4QixDQUNaM0QsS0FBS2tiLGtCQUFMLENBQXdCK0IsWUFBeEIsRUFEWSxDQUFkO0FBR0EsZ0JBQUl3QixXQUFXemUsS0FBS3NiLG1CQUFMLElBQ1IrQyxlQUFlMUQsV0FBVzNULE1BQVgsRUFBbUJxWCxXQUFuQixLQUFtQyxDQUR6RDs7QUFHQSxnQkFBSUksUUFBSixFQUFjO0FBQ1p6ZSxtQkFBS3FkLFlBQUwsQ0FBa0J4WSxFQUFsQixFQUFzQm1DLE1BQXRCO0FBQ0QsYUFGRCxNQUVPO0FBQ0w7QUFDQWhILG1CQUFLc2IsbUJBQUwsR0FBMkIsS0FBM0I7QUFDRDtBQUNGO0FBQ0YsU0FqQ0QsTUFpQ08sSUFBSXlELGNBQUosRUFBb0I7QUFDekJuQixtQkFBUzVkLEtBQUtrYixrQkFBTCxDQUF3QnZYLEdBQXhCLENBQTRCa0IsRUFBNUIsQ0FBVCxDQUR5QixDQUV6QjtBQUNBO0FBQ0E7QUFDQTs7QUFDQTdFLGVBQUtrYixrQkFBTCxDQUF3QnRWLE1BQXhCLENBQStCZixFQUEvQjs7QUFFQSxjQUFJdVosZUFBZXBlLEtBQUtvYixVQUFMLENBQWdCelgsR0FBaEIsQ0FDakIzRCxLQUFLb2IsVUFBTCxDQUFnQjZCLFlBQWhCLEVBRGlCLENBQW5COztBQUVBb0Isd0JBQWNyZSxLQUFLa2Isa0JBQUwsQ0FBd0JwYyxJQUF4QixNQUNSa0IsS0FBS2tiLGtCQUFMLENBQXdCdlgsR0FBeEIsQ0FDRTNELEtBQUtrYixrQkFBTCxDQUF3QitCLFlBQXhCLEVBREYsQ0FETixDQVZ5QixDQWN6Qjs7QUFDQSxjQUFJcUIsWUFBWTNELFdBQVczVCxNQUFYLEVBQW1Cb1gsWUFBbkIsSUFBbUMsQ0FBbkQsQ0FmeUIsQ0FpQnpCOztBQUNBLGNBQUllLGdCQUFpQixDQUFFYixTQUFGLElBQWV0ZSxLQUFLc2IsbUJBQXJCLElBQ2IsQ0FBQ2dELFNBQUQsSUFBY0QsV0FBZCxJQUNBMUQsV0FBVzNULE1BQVgsRUFBbUJxWCxXQUFuQixLQUFtQyxDQUYxQzs7QUFJQSxjQUFJQyxTQUFKLEVBQWU7QUFDYnRlLGlCQUFLK2MsYUFBTCxDQUFtQmxZLEVBQW5CLEVBQXVCbUMsTUFBdkI7QUFDRCxXQUZELE1BRU8sSUFBSW1ZLGFBQUosRUFBbUI7QUFDeEI7QUFDQW5mLGlCQUFLa2Isa0JBQUwsQ0FBd0JwTyxHQUF4QixDQUE0QmpJLEVBQTVCLEVBQWdDbUMsTUFBaEM7QUFDRCxXQUhNLE1BR0E7QUFDTDtBQUNBaEgsaUJBQUtzYixtQkFBTCxHQUEyQixLQUEzQixDQUZLLENBR0w7QUFDQTs7QUFDQSxnQkFBSSxDQUFFdGIsS0FBS2tiLGtCQUFMLENBQXdCcGMsSUFBeEIsRUFBTixFQUFzQztBQUNwQ2tCLG1CQUFLcWMsZ0JBQUw7QUFDRDtBQUNGO0FBQ0YsU0FwQ00sTUFvQ0E7QUFDTCxnQkFBTSxJQUFJNVosS0FBSixDQUFVLDJFQUFWLENBQU47QUFDRDtBQUNGO0FBQ0YsS0EzRkQ7QUE0RkQsR0E3Um9DO0FBOFJyQzJjLDJCQUF5QixZQUFZO0FBQ25DLFFBQUlwZixPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUNsQ3hPLFdBQUt3YixvQkFBTCxDQUEwQnJCLE1BQU1FLFFBQWhDLEVBRGtDLENBRWxDO0FBQ0E7OztBQUNBL1ksYUFBTzJNLEtBQVAsQ0FBYXVNLHdCQUF3QixZQUFZO0FBQy9DLGVBQU8sQ0FBQ3hhLEtBQUswUixRQUFOLElBQWtCLENBQUMxUixLQUFLZ2MsWUFBTCxDQUFrQnVCLEtBQWxCLEVBQTFCLEVBQXFEO0FBQ25ELGNBQUl2ZCxLQUFLc2MsTUFBTCxLQUFnQm5DLE1BQU1DLFFBQTFCLEVBQW9DO0FBQ2xDO0FBQ0E7QUFDQTtBQUNBO0FBQ0QsV0FOa0QsQ0FRbkQ7OztBQUNBLGNBQUlwYSxLQUFLc2MsTUFBTCxLQUFnQm5DLE1BQU1FLFFBQTFCLEVBQ0UsTUFBTSxJQUFJNVgsS0FBSixDQUFVLHNDQUFzQ3pDLEtBQUtzYyxNQUFyRCxDQUFOO0FBRUZ0YyxlQUFLaWMsa0JBQUwsR0FBMEJqYyxLQUFLZ2MsWUFBL0I7QUFDQSxjQUFJcUQsaUJBQWlCLEVBQUVyZixLQUFLa2MsZ0JBQTVCO0FBQ0FsYyxlQUFLZ2MsWUFBTCxHQUFvQixJQUFJclgsZ0JBQWdCaUksTUFBcEIsRUFBcEI7QUFDQSxjQUFJMFMsVUFBVSxDQUFkO0FBQ0EsY0FBSUMsTUFBTSxJQUFJOWlCLE1BQUosRUFBVixDQWhCbUQsQ0FpQm5EO0FBQ0E7O0FBQ0F1RCxlQUFLaWMsa0JBQUwsQ0FBd0IvUSxPQUF4QixDQUFnQyxVQUFVOE0sUUFBVixFQUFvQm5ULEVBQXBCLEVBQXdCO0FBQ3REeWE7O0FBQ0F0ZixpQkFBS3FZLFlBQUwsQ0FBa0JsWCxXQUFsQixDQUE4QitILEtBQTlCLENBQ0VsSixLQUFLOEosa0JBQUwsQ0FBd0JoSCxjQUQxQixFQUMwQytCLEVBRDFDLEVBQzhDbVQsUUFEOUMsRUFFRXdDLHdCQUF3QixVQUFVaFosR0FBVixFQUFlTSxHQUFmLEVBQW9CO0FBQzFDLGtCQUFJO0FBQ0Ysb0JBQUlOLEdBQUosRUFBUztBQUNQRix5QkFBTzZSLE1BQVAsQ0FBYyw2Q0FDQTNSLEdBRGQsRUFETyxDQUdQO0FBQ0E7QUFDQTtBQUNBOzs7QUFDQSxzQkFBSXhCLEtBQUtzYyxNQUFMLEtBQWdCbkMsTUFBTUMsUUFBMUIsRUFBb0M7QUFDbENwYSx5QkFBS3FjLGdCQUFMO0FBQ0Q7QUFDRixpQkFWRCxNQVVPLElBQUksQ0FBQ3JjLEtBQUswUixRQUFOLElBQWtCMVIsS0FBS3NjLE1BQUwsS0FBZ0JuQyxNQUFNRSxRQUF4QyxJQUNHcmEsS0FBS2tjLGdCQUFMLEtBQTBCbUQsY0FEakMsRUFDaUQ7QUFDdEQ7QUFDQTtBQUNBO0FBQ0E7QUFDQXJmLHVCQUFLMmUsVUFBTCxDQUFnQjlaLEVBQWhCLEVBQW9CL0MsR0FBcEI7QUFDRDtBQUNGLGVBbkJELFNBbUJVO0FBQ1J3ZCwwQkFEUSxDQUVSO0FBQ0E7QUFDQTs7QUFDQSxvQkFBSUEsWUFBWSxDQUFoQixFQUNFQyxJQUFJOUssTUFBSjtBQUNIO0FBQ0YsYUE1QkQsQ0FGRjtBQStCRCxXQWpDRDs7QUFrQ0E4SyxjQUFJcmQsSUFBSixHQXJEbUQsQ0FzRG5EOztBQUNBLGNBQUlsQyxLQUFLc2MsTUFBTCxLQUFnQm5DLE1BQU1DLFFBQTFCLEVBQ0U7QUFDRnBhLGVBQUtpYyxrQkFBTCxHQUEwQixJQUExQjtBQUNELFNBM0Q4QyxDQTREL0M7QUFDQTs7O0FBQ0EsWUFBSWpjLEtBQUtzYyxNQUFMLEtBQWdCbkMsTUFBTUMsUUFBMUIsRUFDRXBhLEtBQUt3ZixTQUFMO0FBQ0gsT0FoRVksQ0FBYjtBQWlFRCxLQXJFRDtBQXNFRCxHQXRXb0M7QUF1V3JDQSxhQUFXLFlBQVk7QUFDckIsUUFBSXhmLE9BQU8sSUFBWDs7QUFDQXNCLFdBQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ2xDeE8sV0FBS3diLG9CQUFMLENBQTBCckIsTUFBTUcsTUFBaEM7O0FBQ0EsVUFBSW1GLFNBQVN6ZixLQUFLb2MsZ0NBQWxCO0FBQ0FwYyxXQUFLb2MsZ0NBQUwsR0FBd0MsRUFBeEM7O0FBQ0FwYyxXQUFLMFgsWUFBTCxDQUFrQlgsT0FBbEIsQ0FBMEIsWUFBWTtBQUNwQ3haLFVBQUVLLElBQUYsQ0FBTzZoQixNQUFQLEVBQWUsVUFBVXhGLENBQVYsRUFBYTtBQUMxQkEsWUFBRXBXLFNBQUY7QUFDRCxTQUZEO0FBR0QsT0FKRDtBQUtELEtBVEQ7QUFVRCxHQW5Yb0M7QUFvWHJDMFksNkJBQTJCLFVBQVVyTCxFQUFWLEVBQWM7QUFDdkMsUUFBSWxSLE9BQU8sSUFBWDs7QUFDQXNCLFdBQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ2xDeE8sV0FBS2djLFlBQUwsQ0FBa0JsUCxHQUFsQixDQUFzQm1FLFFBQVFDLEVBQVIsQ0FBdEIsRUFBbUNBLEdBQUd2RixFQUFILENBQU0rVCxRQUFOLEVBQW5DO0FBQ0QsS0FGRDtBQUdELEdBelhvQztBQTBYckNsRCxxQ0FBbUMsVUFBVXRMLEVBQVYsRUFBYztBQUMvQyxRQUFJbFIsT0FBTyxJQUFYOztBQUNBc0IsV0FBT2tOLGdCQUFQLENBQXdCLFlBQVk7QUFDbEMsVUFBSTNKLEtBQUtvTSxRQUFRQyxFQUFSLENBQVQsQ0FEa0MsQ0FFbEM7QUFDQTs7QUFDQSxVQUFJbFIsS0FBS3NjLE1BQUwsS0FBZ0JuQyxNQUFNRSxRQUF0QixLQUNFcmEsS0FBS2ljLGtCQUFMLElBQTJCamMsS0FBS2ljLGtCQUFMLENBQXdCbmIsR0FBeEIsQ0FBNEIrRCxFQUE1QixDQUE1QixJQUNBN0UsS0FBS2djLFlBQUwsQ0FBa0JsYixHQUFsQixDQUFzQitELEVBQXRCLENBRkQsQ0FBSixFQUVpQztBQUMvQjdFLGFBQUtnYyxZQUFMLENBQWtCbFAsR0FBbEIsQ0FBc0JqSSxFQUF0QixFQUEwQnFNLEdBQUd2RixFQUFILENBQU0rVCxRQUFOLEVBQTFCOztBQUNBO0FBQ0Q7O0FBRUQsVUFBSXhPLEdBQUdBLEVBQUgsS0FBVSxHQUFkLEVBQW1CO0FBQ2pCLFlBQUlsUixLQUFLb2IsVUFBTCxDQUFnQnRhLEdBQWhCLENBQW9CK0QsRUFBcEIsS0FDQzdFLEtBQUsrYSxNQUFMLElBQWUvYSxLQUFLa2Isa0JBQUwsQ0FBd0JwYSxHQUF4QixDQUE0QitELEVBQTVCLENBRHBCLEVBRUU3RSxLQUFLMGUsZUFBTCxDQUFxQjdaLEVBQXJCO0FBQ0gsT0FKRCxNQUlPLElBQUlxTSxHQUFHQSxFQUFILEtBQVUsR0FBZCxFQUFtQjtBQUN4QixZQUFJbFIsS0FBS29iLFVBQUwsQ0FBZ0J0YSxHQUFoQixDQUFvQitELEVBQXBCLENBQUosRUFDRSxNQUFNLElBQUlwQyxLQUFKLENBQVUsbURBQVYsQ0FBTjtBQUNGLFlBQUl6QyxLQUFLa2Isa0JBQUwsSUFBMkJsYixLQUFLa2Isa0JBQUwsQ0FBd0JwYSxHQUF4QixDQUE0QitELEVBQTVCLENBQS9CLEVBQ0UsTUFBTSxJQUFJcEMsS0FBSixDQUFVLGdEQUFWLENBQU4sQ0FKc0IsQ0FNeEI7QUFDQTs7QUFDQSxZQUFJekMsS0FBS3liLFFBQUwsQ0FBY29ELGVBQWQsQ0FBOEIzTixHQUFHQyxDQUFqQyxFQUFvQ2hOLE1BQXhDLEVBQ0VuRSxLQUFLbWUsWUFBTCxDQUFrQmpOLEdBQUdDLENBQXJCO0FBQ0gsT0FWTSxNQVVBLElBQUlELEdBQUdBLEVBQUgsS0FBVSxHQUFkLEVBQW1CO0FBQ3hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBSXlPLFlBQVksQ0FBQ3BpQixFQUFFdUQsR0FBRixDQUFNb1EsR0FBR0MsQ0FBVCxFQUFZLE1BQVosQ0FBRCxJQUF3QixDQUFDNVQsRUFBRXVELEdBQUYsQ0FBTW9RLEdBQUdDLENBQVQsRUFBWSxRQUFaLENBQXpDLENBTHdCLENBTXhCO0FBQ0E7QUFDQTtBQUNBOztBQUNBLFlBQUl5Tyx1QkFDRixDQUFDRCxTQUFELElBQWNFLDZCQUE2QjNPLEdBQUdDLENBQWhDLENBRGhCOztBQUdBLFlBQUkyTixrQkFBa0I5ZSxLQUFLb2IsVUFBTCxDQUFnQnRhLEdBQWhCLENBQW9CK0QsRUFBcEIsQ0FBdEI7O0FBQ0EsWUFBSWthLGlCQUFpQi9lLEtBQUsrYSxNQUFMLElBQWUvYSxLQUFLa2Isa0JBQUwsQ0FBd0JwYSxHQUF4QixDQUE0QitELEVBQTVCLENBQXBDOztBQUVBLFlBQUk4YSxTQUFKLEVBQWU7QUFDYjNmLGVBQUsyZSxVQUFMLENBQWdCOVosRUFBaEIsRUFBb0J0SCxFQUFFK0gsTUFBRixDQUFTO0FBQUNSLGlCQUFLRDtBQUFOLFdBQVQsRUFBb0JxTSxHQUFHQyxDQUF2QixDQUFwQjtBQUNELFNBRkQsTUFFTyxJQUFJLENBQUMyTixtQkFBbUJDLGNBQXBCLEtBQ0FhLG9CQURKLEVBQzBCO0FBQy9CO0FBQ0E7QUFDQSxjQUFJNVksU0FBU2hILEtBQUtvYixVQUFMLENBQWdCdGEsR0FBaEIsQ0FBb0IrRCxFQUFwQixJQUNUN0UsS0FBS29iLFVBQUwsQ0FBZ0J6WCxHQUFoQixDQUFvQmtCLEVBQXBCLENBRFMsR0FDaUI3RSxLQUFLa2Isa0JBQUwsQ0FBd0J2WCxHQUF4QixDQUE0QmtCLEVBQTVCLENBRDlCO0FBRUFtQyxtQkFBU2pJLE1BQU1kLEtBQU4sQ0FBWStJLE1BQVosQ0FBVDtBQUVBQSxpQkFBT2xDLEdBQVAsR0FBYUQsRUFBYjs7QUFDQSxjQUFJO0FBQ0ZGLDRCQUFnQm1iLE9BQWhCLENBQXdCOVksTUFBeEIsRUFBZ0NrSyxHQUFHQyxDQUFuQztBQUNELFdBRkQsQ0FFRSxPQUFPMU0sQ0FBUCxFQUFVO0FBQ1YsZ0JBQUlBLEVBQUV0RyxJQUFGLEtBQVcsZ0JBQWYsRUFDRSxNQUFNc0csQ0FBTixDQUZRLENBR1Y7O0FBQ0F6RSxpQkFBS2djLFlBQUwsQ0FBa0JsUCxHQUFsQixDQUFzQmpJLEVBQXRCLEVBQTBCcU0sR0FBR3ZGLEVBQUgsQ0FBTStULFFBQU4sRUFBMUI7O0FBQ0EsZ0JBQUkxZixLQUFLc2MsTUFBTCxLQUFnQm5DLE1BQU1HLE1BQTFCLEVBQWtDO0FBQ2hDdGEsbUJBQUtvZix1QkFBTDtBQUNEOztBQUNEO0FBQ0Q7O0FBQ0RwZixlQUFLMmUsVUFBTCxDQUFnQjlaLEVBQWhCLEVBQW9CN0UsS0FBSytiLG1CQUFMLENBQXlCL1UsTUFBekIsQ0FBcEI7QUFDRCxTQXRCTSxNQXNCQSxJQUFJLENBQUM0WSxvQkFBRCxJQUNBNWYsS0FBS3liLFFBQUwsQ0FBY3NFLHVCQUFkLENBQXNDN08sR0FBR0MsQ0FBekMsQ0FEQSxJQUVDblIsS0FBS2liLE9BQUwsSUFBZ0JqYixLQUFLaWIsT0FBTCxDQUFhK0Usa0JBQWIsQ0FBZ0M5TyxHQUFHQyxDQUFuQyxDQUZyQixFQUU2RDtBQUNsRW5SLGVBQUtnYyxZQUFMLENBQWtCbFAsR0FBbEIsQ0FBc0JqSSxFQUF0QixFQUEwQnFNLEdBQUd2RixFQUFILENBQU0rVCxRQUFOLEVBQTFCOztBQUNBLGNBQUkxZixLQUFLc2MsTUFBTCxLQUFnQm5DLE1BQU1HLE1BQTFCLEVBQ0V0YSxLQUFLb2YsdUJBQUw7QUFDSDtBQUNGLE9BL0NNLE1BK0NBO0FBQ0wsY0FBTTNjLE1BQU0sK0JBQStCeU8sRUFBckMsQ0FBTjtBQUNEO0FBQ0YsS0EzRUQ7QUE0RUQsR0F4Y29DO0FBeWNyQztBQUNBNEwsb0JBQWtCLFlBQVk7QUFDNUIsUUFBSTljLE9BQU8sSUFBWDtBQUNBLFFBQUlBLEtBQUswUixRQUFULEVBQ0UsTUFBTSxJQUFJalAsS0FBSixDQUFVLGtDQUFWLENBQU47O0FBRUZ6QyxTQUFLaWdCLFNBQUwsQ0FBZTtBQUFDQyxlQUFTO0FBQVYsS0FBZixFQUw0QixDQUtNOzs7QUFFbEMsUUFBSWxnQixLQUFLMFIsUUFBVCxFQUNFLE9BUjBCLENBUWpCO0FBRVg7QUFDQTs7QUFDQTFSLFNBQUswWCxZQUFMLENBQWtCZixLQUFsQjs7QUFFQTNXLFNBQUttZ0IsYUFBTCxHQWQ0QixDQWNMOztBQUN4QixHQXpkb0M7QUEyZHJDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQUMsY0FBWSxZQUFZO0FBQ3RCLFFBQUlwZ0IsT0FBTyxJQUFYOztBQUNBc0IsV0FBT2tOLGdCQUFQLENBQXdCLFlBQVk7QUFDbEMsVUFBSXhPLEtBQUswUixRQUFULEVBQ0UsT0FGZ0MsQ0FJbEM7O0FBQ0ExUixXQUFLZ2MsWUFBTCxHQUFvQixJQUFJclgsZ0JBQWdCaUksTUFBcEIsRUFBcEI7QUFDQTVNLFdBQUtpYyxrQkFBTCxHQUEwQixJQUExQjtBQUNBLFFBQUVqYyxLQUFLa2MsZ0JBQVAsQ0FQa0MsQ0FPUjs7QUFDMUJsYyxXQUFLd2Isb0JBQUwsQ0FBMEJyQixNQUFNQyxRQUFoQyxFQVJrQyxDQVVsQztBQUNBOzs7QUFDQTlZLGFBQU8yTSxLQUFQLENBQWEsWUFBWTtBQUN2QmpPLGFBQUtpZ0IsU0FBTDs7QUFDQWpnQixhQUFLbWdCLGFBQUw7QUFDRCxPQUhEO0FBSUQsS0FoQkQ7QUFpQkQsR0E1Zm9DO0FBOGZyQztBQUNBRixhQUFXLFVBQVVsZ0IsT0FBVixFQUFtQjtBQUM1QixRQUFJQyxPQUFPLElBQVg7QUFDQUQsY0FBVUEsV0FBVyxFQUFyQjtBQUNBLFFBQUkyWixVQUFKLEVBQWdCMkcsU0FBaEIsQ0FINEIsQ0FLNUI7O0FBQ0EsV0FBTyxJQUFQLEVBQWE7QUFDWDtBQUNBLFVBQUlyZ0IsS0FBSzBSLFFBQVQsRUFDRTtBQUVGZ0ksbUJBQWEsSUFBSS9VLGdCQUFnQmlJLE1BQXBCLEVBQWI7QUFDQXlULGtCQUFZLElBQUkxYixnQkFBZ0JpSSxNQUFwQixFQUFaLENBTlcsQ0FRWDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFDQSxVQUFJYyxTQUFTMU4sS0FBS3NnQixlQUFMLENBQXFCO0FBQUVyWCxlQUFPakosS0FBSythLE1BQUwsR0FBYztBQUF2QixPQUFyQixDQUFiOztBQUNBLFVBQUk7QUFDRnJOLGVBQU94QyxPQUFQLENBQWUsVUFBVXBKLEdBQVYsRUFBZXllLENBQWYsRUFBa0I7QUFBRztBQUNsQyxjQUFJLENBQUN2Z0IsS0FBSythLE1BQU4sSUFBZ0J3RixJQUFJdmdCLEtBQUsrYSxNQUE3QixFQUFxQztBQUNuQ3JCLHVCQUFXNU0sR0FBWCxDQUFlaEwsSUFBSWdELEdBQW5CLEVBQXdCaEQsR0FBeEI7QUFDRCxXQUZELE1BRU87QUFDTHVlLHNCQUFVdlQsR0FBVixDQUFjaEwsSUFBSWdELEdBQWxCLEVBQXVCaEQsR0FBdkI7QUFDRDtBQUNGLFNBTkQ7QUFPQTtBQUNELE9BVEQsQ0FTRSxPQUFPMkMsQ0FBUCxFQUFVO0FBQ1YsWUFBSTFFLFFBQVFtZ0IsT0FBUixJQUFtQixPQUFPemIsRUFBRW9WLElBQVQsS0FBbUIsUUFBMUMsRUFBb0Q7QUFDbEQ7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBN1osZUFBSzBYLFlBQUwsQ0FBa0JiLFVBQWxCLENBQTZCcFMsQ0FBN0I7O0FBQ0E7QUFDRCxTQVRTLENBV1Y7QUFDQTs7O0FBQ0FuRCxlQUFPNlIsTUFBUCxDQUFjLHdDQUF3QzFPLENBQXREOztBQUNBbkQsZUFBT29TLFdBQVAsQ0FBbUIsR0FBbkI7QUFDRDtBQUNGOztBQUVELFFBQUkxVCxLQUFLMFIsUUFBVCxFQUNFOztBQUVGMVIsU0FBS3dnQixrQkFBTCxDQUF3QjlHLFVBQXhCLEVBQW9DMkcsU0FBcEM7QUFDRCxHQXBqQm9DO0FBc2pCckM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0FoRSxvQkFBa0IsWUFBWTtBQUM1QixRQUFJcmMsT0FBTyxJQUFYOztBQUNBc0IsV0FBT2tOLGdCQUFQLENBQXdCLFlBQVk7QUFDbEMsVUFBSXhPLEtBQUswUixRQUFULEVBQ0UsT0FGZ0MsQ0FJbEM7QUFDQTs7QUFDQSxVQUFJMVIsS0FBS3NjLE1BQUwsS0FBZ0JuQyxNQUFNQyxRQUExQixFQUFvQztBQUNsQ3BhLGFBQUtvZ0IsVUFBTDs7QUFDQSxjQUFNLElBQUk3RixlQUFKLEVBQU47QUFDRCxPQVRpQyxDQVdsQztBQUNBOzs7QUFDQXZhLFdBQUttYyx5QkFBTCxHQUFpQyxJQUFqQztBQUNELEtBZEQ7QUFlRCxHQW5sQm9DO0FBcWxCckM7QUFDQWdFLGlCQUFlLFlBQVk7QUFDekIsUUFBSW5nQixPQUFPLElBQVg7QUFFQSxRQUFJQSxLQUFLMFIsUUFBVCxFQUNFOztBQUNGMVIsU0FBS3FZLFlBQUwsQ0FBa0JuWCxZQUFsQixDQUErQnFTLGlCQUEvQixHQUx5QixDQUs0Qjs7O0FBQ3JELFFBQUl2VCxLQUFLMFIsUUFBVCxFQUNFO0FBQ0YsUUFBSTFSLEtBQUtzYyxNQUFMLEtBQWdCbkMsTUFBTUMsUUFBMUIsRUFDRSxNQUFNM1gsTUFBTSx3QkFBd0J6QyxLQUFLc2MsTUFBbkMsQ0FBTjs7QUFFRmhiLFdBQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUl4TyxLQUFLbWMseUJBQVQsRUFBb0M7QUFDbENuYyxhQUFLbWMseUJBQUwsR0FBaUMsS0FBakM7O0FBQ0FuYyxhQUFLb2dCLFVBQUw7QUFDRCxPQUhELE1BR08sSUFBSXBnQixLQUFLZ2MsWUFBTCxDQUFrQnVCLEtBQWxCLEVBQUosRUFBK0I7QUFDcEN2ZCxhQUFLd2YsU0FBTDtBQUNELE9BRk0sTUFFQTtBQUNMeGYsYUFBS29mLHVCQUFMO0FBQ0Q7QUFDRixLQVREO0FBVUQsR0EzbUJvQztBQTZtQnJDa0IsbUJBQWlCLFVBQVVHLGdCQUFWLEVBQTRCO0FBQzNDLFFBQUl6Z0IsT0FBTyxJQUFYO0FBQ0EsV0FBT3NCLE9BQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ3pDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxVQUFJek8sVUFBVXhDLEVBQUVVLEtBQUYsQ0FBUStCLEtBQUs4SixrQkFBTCxDQUF3Qi9KLE9BQWhDLENBQWQsQ0FOeUMsQ0FRekM7QUFDQTs7O0FBQ0F4QyxRQUFFK0gsTUFBRixDQUFTdkYsT0FBVCxFQUFrQjBnQixnQkFBbEI7O0FBRUExZ0IsY0FBUStMLE1BQVIsR0FBaUI5TCxLQUFLNmIsaUJBQXRCO0FBQ0EsYUFBTzliLFFBQVF1SyxTQUFmLENBYnlDLENBY3pDOztBQUNBLFVBQUlvVyxjQUFjLElBQUkzWCxpQkFBSixDQUNoQi9JLEtBQUs4SixrQkFBTCxDQUF3QmhILGNBRFIsRUFFaEI5QyxLQUFLOEosa0JBQUwsQ0FBd0I1RSxRQUZSLEVBR2hCbkYsT0FIZ0IsQ0FBbEI7QUFJQSxhQUFPLElBQUkrSSxNQUFKLENBQVc5SSxLQUFLcVksWUFBaEIsRUFBOEJxSSxXQUE5QixDQUFQO0FBQ0QsS0FwQk0sQ0FBUDtBQXFCRCxHQXBvQm9DO0FBdW9CckM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQUYsc0JBQW9CLFVBQVU5RyxVQUFWLEVBQXNCMkcsU0FBdEIsRUFBaUM7QUFDbkQsUUFBSXJnQixPQUFPLElBQVg7O0FBQ0FzQixXQUFPa04sZ0JBQVAsQ0FBd0IsWUFBWTtBQUVsQztBQUNBO0FBQ0EsVUFBSXhPLEtBQUsrYSxNQUFULEVBQWlCO0FBQ2YvYSxhQUFLa2Isa0JBQUwsQ0FBd0J0RyxLQUF4QjtBQUNELE9BTmlDLENBUWxDO0FBQ0E7OztBQUNBLFVBQUkrTCxjQUFjLEVBQWxCOztBQUNBM2dCLFdBQUtvYixVQUFMLENBQWdCbFEsT0FBaEIsQ0FBd0IsVUFBVXBKLEdBQVYsRUFBZStDLEVBQWYsRUFBbUI7QUFDekMsWUFBSSxDQUFDNlUsV0FBVzVZLEdBQVgsQ0FBZStELEVBQWYsQ0FBTCxFQUNFOGIsWUFBWXhULElBQVosQ0FBaUJ0SSxFQUFqQjtBQUNILE9BSEQ7O0FBSUF0SCxRQUFFSyxJQUFGLENBQU8raUIsV0FBUCxFQUFvQixVQUFVOWIsRUFBVixFQUFjO0FBQ2hDN0UsYUFBS3NkLGdCQUFMLENBQXNCelksRUFBdEI7QUFDRCxPQUZELEVBZmtDLENBbUJsQztBQUNBO0FBQ0E7OztBQUNBNlUsaUJBQVd4TyxPQUFYLENBQW1CLFVBQVVwSixHQUFWLEVBQWUrQyxFQUFmLEVBQW1CO0FBQ3BDN0UsYUFBSzJlLFVBQUwsQ0FBZ0I5WixFQUFoQixFQUFvQi9DLEdBQXBCO0FBQ0QsT0FGRCxFQXRCa0MsQ0EwQmxDO0FBQ0E7QUFDQTs7QUFDQSxVQUFJOUIsS0FBS29iLFVBQUwsQ0FBZ0J0YyxJQUFoQixPQUEyQjRhLFdBQVc1YSxJQUFYLEVBQS9CLEVBQWtEO0FBQ2hELGNBQU0yRCxNQUNKLDJEQUNFLCtEQURGLEdBRUUsMkJBRkYsR0FHRTFELE1BQU1xUCxTQUFOLENBQWdCcE8sS0FBSzhKLGtCQUFMLENBQXdCNUUsUUFBeEMsQ0FKRSxDQUFOO0FBS0Q7O0FBQ0RsRixXQUFLb2IsVUFBTCxDQUFnQmxRLE9BQWhCLENBQXdCLFVBQVVwSixHQUFWLEVBQWUrQyxFQUFmLEVBQW1CO0FBQ3pDLFlBQUksQ0FBQzZVLFdBQVc1WSxHQUFYLENBQWUrRCxFQUFmLENBQUwsRUFDRSxNQUFNcEMsTUFBTSxtREFBbURvQyxFQUF6RCxDQUFOO0FBQ0gsT0FIRCxFQXBDa0MsQ0F5Q2xDOzs7QUFDQXdiLGdCQUFVblYsT0FBVixDQUFrQixVQUFVcEosR0FBVixFQUFlK0MsRUFBZixFQUFtQjtBQUNuQzdFLGFBQUtxZCxZQUFMLENBQWtCeFksRUFBbEIsRUFBc0IvQyxHQUF0QjtBQUNELE9BRkQ7QUFJQTlCLFdBQUtzYixtQkFBTCxHQUEyQitFLFVBQVV2aEIsSUFBVixLQUFtQmtCLEtBQUsrYSxNQUFuRDtBQUNELEtBL0NEO0FBZ0RELEdBaHNCb0M7QUFrc0JyQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQXBZLFFBQU0sWUFBWTtBQUNoQixRQUFJM0MsT0FBTyxJQUFYO0FBQ0EsUUFBSUEsS0FBSzBSLFFBQVQsRUFDRTtBQUNGMVIsU0FBSzBSLFFBQUwsR0FBZ0IsSUFBaEI7O0FBQ0FuVSxNQUFFSyxJQUFGLENBQU9vQyxLQUFLdWIsWUFBWixFQUEwQixVQUFVcEYsTUFBVixFQUFrQjtBQUMxQ0EsYUFBT3hULElBQVA7QUFDRCxLQUZELEVBTGdCLENBU2hCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUNBcEYsTUFBRUssSUFBRixDQUFPb0MsS0FBS29jLGdDQUFaLEVBQThDLFVBQVVuQyxDQUFWLEVBQWE7QUFDekRBLFFBQUVwVyxTQUFGLEdBRHlELENBQ3pDO0FBQ2pCLEtBRkQ7O0FBR0E3RCxTQUFLb2MsZ0NBQUwsR0FBd0MsSUFBeEMsQ0FqQmdCLENBbUJoQjs7QUFDQXBjLFNBQUtvYixVQUFMLEdBQWtCLElBQWxCO0FBQ0FwYixTQUFLa2Isa0JBQUwsR0FBMEIsSUFBMUI7QUFDQWxiLFNBQUtnYyxZQUFMLEdBQW9CLElBQXBCO0FBQ0FoYyxTQUFLaWMsa0JBQUwsR0FBMEIsSUFBMUI7QUFDQWpjLFNBQUs0Z0IsaUJBQUwsR0FBeUIsSUFBekI7QUFDQTVnQixTQUFLNmdCLGdCQUFMLEdBQXdCLElBQXhCO0FBRUF6ZSxZQUFRZ1QsS0FBUixJQUFpQmhULFFBQVFnVCxLQUFSLENBQWNDLEtBQWQsQ0FBb0JDLG1CQUFwQixDQUNmLGdCQURlLEVBQ0csdUJBREgsRUFDNEIsQ0FBQyxDQUQ3QixDQUFqQjtBQUVELEdBcnVCb0M7QUF1dUJyQ2tHLHdCQUFzQixVQUFVc0YsS0FBVixFQUFpQjtBQUNyQyxRQUFJOWdCLE9BQU8sSUFBWDs7QUFDQXNCLFdBQU9rTixnQkFBUCxDQUF3QixZQUFZO0FBQ2xDLFVBQUl1UyxNQUFNLElBQUlDLElBQUosRUFBVjs7QUFFQSxVQUFJaGhCLEtBQUtzYyxNQUFULEVBQWlCO0FBQ2YsWUFBSTJFLFdBQVdGLE1BQU0vZ0IsS0FBS2toQixlQUExQjtBQUNBOWUsZ0JBQVFnVCxLQUFSLElBQWlCaFQsUUFBUWdULEtBQVIsQ0FBY0MsS0FBZCxDQUFvQkMsbUJBQXBCLENBQ2YsZ0JBRGUsRUFDRyxtQkFBbUJ0VixLQUFLc2MsTUFBeEIsR0FBaUMsUUFEcEMsRUFDOEMyRSxRQUQ5QyxDQUFqQjtBQUVEOztBQUVEamhCLFdBQUtzYyxNQUFMLEdBQWN3RSxLQUFkO0FBQ0E5Z0IsV0FBS2toQixlQUFMLEdBQXVCSCxHQUF2QjtBQUNELEtBWEQ7QUFZRDtBQXJ2Qm9DLENBQXZDLEUsQ0F3dkJBO0FBQ0E7QUFDQTs7O0FBQ0EzUixtQkFBbUJDLGVBQW5CLEdBQXFDLFVBQVV6RixpQkFBVixFQUE2QmlGLE9BQTdCLEVBQXNDO0FBQ3pFO0FBQ0EsTUFBSTlPLFVBQVU2SixrQkFBa0I3SixPQUFoQyxDQUZ5RSxDQUl6RTtBQUNBOztBQUNBLE1BQUlBLFFBQVFvaEIsWUFBUixJQUF3QnBoQixRQUFRcWhCLGFBQXBDLEVBQ0UsT0FBTyxLQUFQLENBUHVFLENBU3pFO0FBQ0E7QUFDQTtBQUNBOztBQUNBLE1BQUlyaEIsUUFBUXdMLElBQVIsSUFBaUJ4TCxRQUFRa0osS0FBUixJQUFpQixDQUFDbEosUUFBUXVMLElBQS9DLEVBQXNELE9BQU8sS0FBUCxDQWJtQixDQWV6RTtBQUNBOztBQUNBLE1BQUl2TCxRQUFRK0wsTUFBWixFQUFvQjtBQUNsQixRQUFJO0FBQ0ZuSCxzQkFBZ0IwYyx5QkFBaEIsQ0FBMEN0aEIsUUFBUStMLE1BQWxEO0FBQ0QsS0FGRCxDQUVFLE9BQU9ySCxDQUFQLEVBQVU7QUFDVixVQUFJQSxFQUFFdEcsSUFBRixLQUFXLGdCQUFmLEVBQWlDO0FBQy9CLGVBQU8sS0FBUDtBQUNELE9BRkQsTUFFTztBQUNMLGNBQU1zRyxDQUFOO0FBQ0Q7QUFDRjtBQUNGLEdBM0J3RSxDQTZCekU7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FBQ0EsU0FBTyxDQUFDb0ssUUFBUXlTLFFBQVIsRUFBRCxJQUF1QixDQUFDelMsUUFBUTBTLFdBQVIsRUFBL0I7QUFDRCxDQXRDRDs7QUF3Q0EsSUFBSTFCLCtCQUErQixVQUFVMkIsUUFBVixFQUFvQjtBQUNyRCxTQUFPamtCLEVBQUV5UixHQUFGLENBQU13UyxRQUFOLEVBQWdCLFVBQVUxVixNQUFWLEVBQWtCMlYsU0FBbEIsRUFBNkI7QUFDbEQsV0FBT2xrQixFQUFFeVIsR0FBRixDQUFNbEQsTUFBTixFQUFjLFVBQVVqTyxLQUFWLEVBQWlCNmpCLEtBQWpCLEVBQXdCO0FBQzNDLGFBQU8sQ0FBQyxVQUFVOWdCLElBQVYsQ0FBZThnQixLQUFmLENBQVI7QUFDRCxLQUZNLENBQVA7QUFHRCxHQUpNLENBQVA7QUFLRCxDQU5EOztBQVFBOWtCLGVBQWV3UyxrQkFBZixHQUFvQ0Esa0JBQXBDLEM7Ozs7Ozs7Ozs7O0FDNytCQWxTLE9BQU95a0IsTUFBUCxDQUFjO0FBQUNDLHlCQUFzQixNQUFJQTtBQUEzQixDQUFkO0FBQ08sTUFBTUEsd0JBQXdCLElBQUssTUFBTUEscUJBQU4sQ0FBNEI7QUFDcEVDLGdCQUFjO0FBQ1osU0FBS0MsaUJBQUwsR0FBeUJ6aEIsT0FBTzBoQixNQUFQLENBQWMsSUFBZCxDQUF6QjtBQUNEOztBQUVEQyxPQUFLN2pCLElBQUwsRUFBVzhqQixJQUFYLEVBQWlCO0FBQ2YsUUFBSSxDQUFFOWpCLElBQU4sRUFBWTtBQUNWLGFBQU8sSUFBSXdHLGVBQUosRUFBUDtBQUNEOztBQUVELFFBQUksQ0FBRXNkLElBQU4sRUFBWTtBQUNWLGFBQU9DLGlCQUFpQi9qQixJQUFqQixFQUF1QixLQUFLMmpCLGlCQUE1QixDQUFQO0FBQ0Q7O0FBRUQsUUFBSSxDQUFFRyxLQUFLRSwyQkFBWCxFQUF3QztBQUN0Q0YsV0FBS0UsMkJBQUwsR0FBbUM5aEIsT0FBTzBoQixNQUFQLENBQWMsSUFBZCxDQUFuQztBQUNELEtBWGMsQ0FhZjtBQUNBOzs7QUFDQSxXQUFPRyxpQkFBaUIvakIsSUFBakIsRUFBdUI4akIsS0FBS0UsMkJBQTVCLENBQVA7QUFDRDs7QUFyQm1FLENBQWpDLEVBQTlCOztBQXdCUCxTQUFTRCxnQkFBVCxDQUEwQi9qQixJQUExQixFQUFnQ2lrQixXQUFoQyxFQUE2QztBQUMzQyxTQUFRamtCLFFBQVFpa0IsV0FBVCxHQUNIQSxZQUFZamtCLElBQVosQ0FERyxHQUVIaWtCLFlBQVlqa0IsSUFBWixJQUFvQixJQUFJd0csZUFBSixDQUFvQnhHLElBQXBCLENBRnhCO0FBR0QsQzs7Ozs7Ozs7Ozs7QUM3QkR2QixlQUFleWxCLHNCQUFmLEdBQXdDLFVBQ3RDQyxTQURzQyxFQUMzQnZpQixPQUQyQixFQUNsQjtBQUNwQixNQUFJQyxPQUFPLElBQVg7QUFDQUEsT0FBSzJKLEtBQUwsR0FBYSxJQUFJOUosZUFBSixDQUFvQnlpQixTQUFwQixFQUErQnZpQixPQUEvQixDQUFiO0FBQ0QsQ0FKRDs7QUFNQXhDLEVBQUUrSCxNQUFGLENBQVMxSSxlQUFleWxCLHNCQUFmLENBQXNDcmtCLFNBQS9DLEVBQTBEO0FBQ3hEZ2tCLFFBQU0sVUFBVTdqQixJQUFWLEVBQWdCO0FBQ3BCLFFBQUk2QixPQUFPLElBQVg7QUFDQSxRQUFJckMsTUFBTSxFQUFWOztBQUNBSixNQUFFSyxJQUFGLENBQ0UsQ0FBQyxNQUFELEVBQVMsU0FBVCxFQUFvQixRQUFwQixFQUE4QixRQUE5QixFQUF3QyxRQUF4QyxFQUNDLFFBREQsRUFDVyxjQURYLEVBQzJCLFlBRDNCLEVBQ3lDLHlCQUR6QyxFQUVDLGdCQUZELEVBRW1CLGVBRm5CLENBREYsRUFJRSxVQUFVMmtCLENBQVYsRUFBYTtBQUNYNWtCLFVBQUk0a0IsQ0FBSixJQUFTaGxCLEVBQUVHLElBQUYsQ0FBT3NDLEtBQUsySixLQUFMLENBQVc0WSxDQUFYLENBQVAsRUFBc0J2aUIsS0FBSzJKLEtBQTNCLEVBQWtDeEwsSUFBbEMsQ0FBVDtBQUNELEtBTkg7O0FBT0EsV0FBT1IsR0FBUDtBQUNEO0FBWnVELENBQTFELEUsQ0FnQkE7QUFDQTtBQUNBOzs7QUFDQWYsZUFBZTRsQiw2QkFBZixHQUErQ2psQixFQUFFa2xCLElBQUYsQ0FBTyxZQUFZO0FBQ2hFLE1BQUlDLG9CQUFvQixFQUF4QjtBQUVBLE1BQUlDLFdBQVdoUyxRQUFRQyxHQUFSLENBQVlnUyxTQUEzQjs7QUFFQSxNQUFJalMsUUFBUUMsR0FBUixDQUFZaVMsZUFBaEIsRUFBaUM7QUFDL0JILHNCQUFrQnZnQixRQUFsQixHQUE2QndPLFFBQVFDLEdBQVIsQ0FBWWlTLGVBQXpDO0FBQ0Q7O0FBRUQsTUFBSSxDQUFFRixRQUFOLEVBQ0UsTUFBTSxJQUFJbGdCLEtBQUosQ0FBVSxzQ0FBVixDQUFOO0FBRUYsU0FBTyxJQUFJN0YsZUFBZXlsQixzQkFBbkIsQ0FBMENNLFFBQTFDLEVBQW9ERCxpQkFBcEQsQ0FBUDtBQUNELENBYjhDLENBQS9DLEM7Ozs7Ozs7Ozs7Ozs7QUN6QkE7QUFDQTs7QUFFQTs7OztBQUlBOWpCLFFBQVEsRUFBUjtBQUVBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFpQkFBLE1BQU02SyxVQUFOLEdBQW1CLFNBQVNBLFVBQVQsQ0FBb0J0TCxJQUFwQixFQUEwQjRCLE9BQTFCLEVBQW1DO0FBQ3BELE1BQUksQ0FBQzVCLElBQUQsSUFBVUEsU0FBUyxJQUF2QixFQUE4QjtBQUM1Qm1ELFdBQU82UixNQUFQLENBQWMsNERBQ0EseURBREEsR0FFQSxnREFGZDs7QUFHQWhWLFdBQU8sSUFBUDtBQUNEOztBQUVELE1BQUlBLFNBQVMsSUFBVCxJQUFpQixPQUFPQSxJQUFQLEtBQWdCLFFBQXJDLEVBQStDO0FBQzdDLFVBQU0sSUFBSXNFLEtBQUosQ0FDSixpRUFESSxDQUFOO0FBRUQ7O0FBRUQsTUFBSTFDLFdBQVdBLFFBQVErSyxPQUF2QixFQUFnQztBQUM5QjtBQUNBO0FBQ0E7QUFDQTtBQUNBL0ssY0FBVTtBQUFDK2lCLGtCQUFZL2lCO0FBQWIsS0FBVjtBQUNELEdBbkJtRCxDQW9CcEQ7OztBQUNBLE1BQUlBLFdBQVdBLFFBQVFnakIsT0FBbkIsSUFBOEIsQ0FBQ2hqQixRQUFRK2lCLFVBQTNDLEVBQXVEO0FBQ3JEL2lCLFlBQVEraUIsVUFBUixHQUFxQi9pQixRQUFRZ2pCLE9BQTdCO0FBQ0Q7O0FBRURoakI7QUFDRStpQixnQkFBWTdqQixTQURkO0FBRUUrakIsa0JBQWMsUUFGaEI7QUFHRTFZLGVBQVcsSUFIYjtBQUlFMlksYUFBU2hrQixTQUpYO0FBS0Vpa0IseUJBQXFCO0FBTHZCLEtBTU9uakIsT0FOUDs7QUFTQSxVQUFRQSxRQUFRaWpCLFlBQWhCO0FBQ0EsU0FBSyxPQUFMO0FBQ0UsV0FBS0csVUFBTCxHQUFrQixZQUFZO0FBQzVCLFlBQUlDLE1BQU1qbEIsT0FBT2tsQixJQUFJQyxZQUFKLENBQWlCLGlCQUFpQm5sQixJQUFsQyxDQUFQLEdBQWlEb2xCLE9BQU9DLFFBQWxFO0FBQ0EsZUFBTyxJQUFJNWtCLE1BQU1ELFFBQVYsQ0FBbUJ5a0IsSUFBSUssU0FBSixDQUFjLEVBQWQsQ0FBbkIsQ0FBUDtBQUNELE9BSEQ7O0FBSUE7O0FBQ0YsU0FBSyxRQUFMO0FBQ0E7QUFDRSxXQUFLTixVQUFMLEdBQWtCLFlBQVk7QUFDNUIsWUFBSUMsTUFBTWpsQixPQUFPa2xCLElBQUlDLFlBQUosQ0FBaUIsaUJBQWlCbmxCLElBQWxDLENBQVAsR0FBaURvbEIsT0FBT0MsUUFBbEU7QUFDQSxlQUFPSixJQUFJdmUsRUFBSixFQUFQO0FBQ0QsT0FIRDs7QUFJQTtBQWJGOztBQWdCQSxPQUFLd0gsVUFBTCxHQUFrQjFILGdCQUFnQjJILGFBQWhCLENBQThCdk0sUUFBUXVLLFNBQXRDLENBQWxCO0FBRUEsTUFBSSxDQUFFbk0sSUFBRixJQUFVNEIsUUFBUStpQixVQUFSLEtBQXVCLElBQXJDLEVBQ0U7QUFDQSxTQUFLWSxXQUFMLEdBQW1CLElBQW5CLENBRkYsS0FHSyxJQUFJM2pCLFFBQVEraUIsVUFBWixFQUNILEtBQUtZLFdBQUwsR0FBbUIzakIsUUFBUStpQixVQUEzQixDQURHLEtBRUEsSUFBSXhoQixPQUFPcWlCLFFBQVgsRUFDSCxLQUFLRCxXQUFMLEdBQW1CcGlCLE9BQU93aEIsVUFBMUIsQ0FERyxLQUdILEtBQUtZLFdBQUwsR0FBbUJwaUIsT0FBT3NpQixNQUExQjs7QUFFRixNQUFJLENBQUM3akIsUUFBUWtqQixPQUFiLEVBQXNCO0FBQ3BCO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsUUFBSTlrQixRQUFRLEtBQUt1bEIsV0FBTCxLQUFxQnBpQixPQUFPc2lCLE1BQXBDLElBQ0EsT0FBT2huQixjQUFQLEtBQTBCLFdBRDFCLElBRUFBLGVBQWU0bEIsNkJBRm5CLEVBRWtEO0FBQ2hEemlCLGNBQVFrakIsT0FBUixHQUFrQnJtQixlQUFlNGxCLDZCQUFmLEVBQWxCO0FBQ0QsS0FKRCxNQUlPO0FBQ0wsWUFBTTtBQUFFWjtBQUFGLFVBQ0pqbEIsUUFBUSw4QkFBUixDQURGOztBQUVBb0QsY0FBUWtqQixPQUFSLEdBQWtCckIscUJBQWxCO0FBQ0Q7QUFDRjs7QUFFRCxPQUFLaUMsV0FBTCxHQUFtQjlqQixRQUFRa2pCLE9BQVIsQ0FBZ0JqQixJQUFoQixDQUFxQjdqQixJQUFyQixFQUEyQixLQUFLdWxCLFdBQWhDLENBQW5CO0FBQ0EsT0FBS0ksS0FBTCxHQUFhM2xCLElBQWI7QUFDQSxPQUFLOGtCLE9BQUwsR0FBZWxqQixRQUFRa2pCLE9BQXZCOztBQUVBLE9BQUtjLHNCQUFMLENBQTRCNWxCLElBQTVCLEVBQWtDNEIsT0FBbEMsRUFsRm9ELENBb0ZwRDtBQUNBO0FBQ0E7OztBQUNBLE1BQUlBLFFBQVFpa0IscUJBQVIsS0FBa0MsS0FBdEMsRUFBNkM7QUFDM0MsUUFBSTtBQUNGLFdBQUtDLHNCQUFMLENBQTRCO0FBQzFCQyxxQkFBYW5rQixRQUFRb2tCLHNCQUFSLEtBQW1DO0FBRHRCLE9BQTVCO0FBR0QsS0FKRCxDQUlFLE9BQU85YyxLQUFQLEVBQWM7QUFDZDtBQUNBLFVBQUlBLE1BQU15UyxPQUFOLEtBQW1CLG9CQUFtQjNiLElBQUssNkJBQS9DLEVBQ0UsTUFBTSxJQUFJc0UsS0FBSixDQUFXLHdDQUF1Q3RFLElBQUssR0FBdkQsQ0FBTjtBQUNGLFlBQU1rSixLQUFOO0FBQ0Q7QUFDRixHQWxHbUQsQ0FvR3BEOzs7QUFDQSxNQUFJakYsUUFBUWdpQixXQUFSLElBQ0EsQ0FBRXJrQixRQUFRbWpCLG1CQURWLElBRUEsS0FBS1EsV0FGTCxJQUdBLEtBQUtBLFdBQUwsQ0FBaUJXLE9BSHJCLEVBRzhCO0FBQzVCLFNBQUtYLFdBQUwsQ0FBaUJXLE9BQWpCLENBQXlCLElBQXpCLEVBQStCLE1BQU0sS0FBS3hiLElBQUwsRUFBckMsRUFBa0Q7QUFDaER5YixlQUFTO0FBRHVDLEtBQWxEO0FBR0Q7QUFDRixDQTdHRDs7QUErR0Fqa0IsT0FBT0MsTUFBUCxDQUFjMUIsTUFBTTZLLFVBQU4sQ0FBaUJ6TCxTQUEvQixFQUEwQztBQUN4QytsQix5QkFBdUI1bEIsSUFBdkIsRUFBNkI7QUFDM0JnbUIsNkJBQXlCO0FBREUsR0FBN0IsRUFFRztBQUNELFVBQU1ua0IsT0FBTyxJQUFiOztBQUNBLFFBQUksRUFBR0EsS0FBSzBqQixXQUFMLElBQ0ExakIsS0FBSzBqQixXQUFMLENBQWlCYSxhQURwQixDQUFKLEVBQ3dDO0FBQ3RDO0FBQ0QsS0FMQSxDQU9EO0FBQ0E7QUFDQTs7O0FBQ0EsVUFBTUMsS0FBS3hrQixLQUFLMGpCLFdBQUwsQ0FBaUJhLGFBQWpCLENBQStCcG1CLElBQS9CLEVBQXFDO0FBQzlDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0FzbUIsa0JBQVlDLFNBQVosRUFBdUJDLEtBQXZCLEVBQThCO0FBQzVCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxZQUFJRCxZQUFZLENBQVosSUFBaUJDLEtBQXJCLEVBQ0Uza0IsS0FBSzZqQixXQUFMLENBQWlCZSxjQUFqQjtBQUVGLFlBQUlELEtBQUosRUFDRTNrQixLQUFLNmpCLFdBQUwsQ0FBaUJqZSxNQUFqQixDQUF3QixFQUF4QjtBQUNILE9BdEI2Qzs7QUF3QjlDO0FBQ0E7QUFDQTZCLGFBQU9vZCxHQUFQLEVBQVk7QUFDVixZQUFJQyxVQUFVQyxRQUFRQyxPQUFSLENBQWdCSCxJQUFJaGdCLEVBQXBCLENBQWQ7O0FBQ0EsWUFBSS9DLE1BQU05QixLQUFLNmpCLFdBQUwsQ0FBaUI3YSxPQUFqQixDQUF5QjhiLE9BQXpCLENBQVYsQ0FGVSxDQUlWO0FBQ0E7QUFDQTs7O0FBQ0EsWUFBSUQsSUFBSUEsR0FBSixLQUFZLFNBQWhCLEVBQTJCO0FBQ3pCLGNBQUlJLFVBQVVKLElBQUlJLE9BQWxCOztBQUNBLGNBQUksQ0FBQ0EsT0FBTCxFQUFjO0FBQ1osZ0JBQUluakIsR0FBSixFQUNFOUIsS0FBSzZqQixXQUFMLENBQWlCamUsTUFBakIsQ0FBd0JrZixPQUF4QjtBQUNILFdBSEQsTUFHTyxJQUFJLENBQUNoakIsR0FBTCxFQUFVO0FBQ2Y5QixpQkFBSzZqQixXQUFMLENBQWlCOWUsTUFBakIsQ0FBd0JrZ0IsT0FBeEI7QUFDRCxXQUZNLE1BRUE7QUFDTDtBQUNBamxCLGlCQUFLNmpCLFdBQUwsQ0FBaUJwYyxNQUFqQixDQUF3QnFkLE9BQXhCLEVBQWlDRyxPQUFqQztBQUNEOztBQUNEO0FBQ0QsU0FaRCxNQVlPLElBQUlKLElBQUlBLEdBQUosS0FBWSxPQUFoQixFQUF5QjtBQUM5QixjQUFJL2lCLEdBQUosRUFBUztBQUNQLGtCQUFNLElBQUlXLEtBQUosQ0FBVSw0REFBVixDQUFOO0FBQ0Q7O0FBQ0R6QyxlQUFLNmpCLFdBQUwsQ0FBaUI5ZSxNQUFqQjtBQUEwQkQsaUJBQUtnZ0I7QUFBL0IsYUFBMkNELElBQUkvWSxNQUEvQztBQUNELFNBTE0sTUFLQSxJQUFJK1ksSUFBSUEsR0FBSixLQUFZLFNBQWhCLEVBQTJCO0FBQ2hDLGNBQUksQ0FBQy9pQixHQUFMLEVBQ0UsTUFBTSxJQUFJVyxLQUFKLENBQVUseURBQVYsQ0FBTjs7QUFDRnpDLGVBQUs2akIsV0FBTCxDQUFpQmplLE1BQWpCLENBQXdCa2YsT0FBeEI7QUFDRCxTQUpNLE1BSUEsSUFBSUQsSUFBSUEsR0FBSixLQUFZLFNBQWhCLEVBQTJCO0FBQ2hDLGNBQUksQ0FBQy9pQixHQUFMLEVBQ0UsTUFBTSxJQUFJVyxLQUFKLENBQVUsdUNBQVYsQ0FBTjtBQUNGLGdCQUFNMFUsT0FBTzlXLE9BQU84VyxJQUFQLENBQVkwTixJQUFJL1ksTUFBaEIsQ0FBYjs7QUFDQSxjQUFJcUwsS0FBS3RQLE1BQUwsR0FBYyxDQUFsQixFQUFxQjtBQUNuQixnQkFBSTJaLFdBQVcsRUFBZjtBQUNBckssaUJBQUtqTSxPQUFMLENBQWFwTixPQUFPO0FBQ2xCLG9CQUFNRCxRQUFRZ25CLElBQUkvWSxNQUFKLENBQVdoTyxHQUFYLENBQWQ7O0FBQ0Esa0JBQUksT0FBT0QsS0FBUCxLQUFpQixXQUFyQixFQUFrQztBQUNoQyxvQkFBSSxDQUFDMmpCLFNBQVMwRCxNQUFkLEVBQXNCO0FBQ3BCMUQsMkJBQVMwRCxNQUFULEdBQWtCLEVBQWxCO0FBQ0Q7O0FBQ0QxRCx5QkFBUzBELE1BQVQsQ0FBZ0JwbkIsR0FBaEIsSUFBdUIsQ0FBdkI7QUFDRCxlQUxELE1BS087QUFDTCxvQkFBSSxDQUFDMGpCLFNBQVMyRCxJQUFkLEVBQW9CO0FBQ2xCM0QsMkJBQVMyRCxJQUFULEdBQWdCLEVBQWhCO0FBQ0Q7O0FBQ0QzRCx5QkFBUzJELElBQVQsQ0FBY3JuQixHQUFkLElBQXFCRCxLQUFyQjtBQUNEO0FBQ0YsYUFiRDs7QUFjQW1DLGlCQUFLNmpCLFdBQUwsQ0FBaUJwYyxNQUFqQixDQUF3QnFkLE9BQXhCLEVBQWlDdEQsUUFBakM7QUFDRDtBQUNGLFNBdEJNLE1Bc0JBO0FBQ0wsZ0JBQU0sSUFBSS9lLEtBQUosQ0FBVSw0Q0FBVixDQUFOO0FBQ0Q7QUFDRixPQS9FNkM7O0FBaUY5QztBQUNBMmlCLGtCQUFZO0FBQ1ZwbEIsYUFBSzZqQixXQUFMLENBQWlCd0IsZUFBakI7QUFDRCxPQXBGNkM7O0FBc0Y5QztBQUNBO0FBQ0FDLHNCQUFnQjtBQUNkdGxCLGFBQUs2akIsV0FBTCxDQUFpQnlCLGFBQWpCO0FBQ0QsT0ExRjZDOztBQTJGOUNDLDBCQUFvQjtBQUNsQixlQUFPdmxCLEtBQUs2akIsV0FBTCxDQUFpQjBCLGlCQUFqQixFQUFQO0FBQ0QsT0E3RjZDOztBQStGOUM7QUFDQUMsYUFBTzNnQixFQUFQLEVBQVc7QUFDVCxlQUFPN0UsS0FBS2dKLE9BQUwsQ0FBYW5FLEVBQWIsQ0FBUDtBQUNELE9BbEc2Qzs7QUFvRzlDO0FBQ0E0Z0IsdUJBQWlCO0FBQ2YsZUFBT3psQixJQUFQO0FBQ0Q7O0FBdkc2QyxLQUFyQyxDQUFYOztBQTBHQSxRQUFJLENBQUV3a0IsRUFBTixFQUFVO0FBQ1IsWUFBTTFLLFVBQVcsd0NBQXVDM2IsSUFBSyxHQUE3RDs7QUFDQSxVQUFJZ21CLDJCQUEyQixJQUEvQixFQUFxQztBQUNuQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBdUIsZ0JBQVFDLElBQVIsR0FBZUQsUUFBUUMsSUFBUixDQUFhN0wsT0FBYixDQUFmLEdBQXVDNEwsUUFBUUUsR0FBUixDQUFZOUwsT0FBWixDQUF2QztBQUNELE9BVEQsTUFTTztBQUNMLGNBQU0sSUFBSXJYLEtBQUosQ0FBVXFYLE9BQVYsQ0FBTjtBQUNEO0FBQ0Y7QUFDRixHQXRJdUM7O0FBd0l4QztBQUNBO0FBQ0E7QUFFQStMLG1CQUFpQjVPLElBQWpCLEVBQXVCO0FBQ3JCLFFBQUlBLEtBQUtwUCxNQUFMLElBQWUsQ0FBbkIsRUFDRSxPQUFPLEVBQVAsQ0FERixLQUdFLE9BQU9vUCxLQUFLLENBQUwsQ0FBUDtBQUNILEdBakp1Qzs7QUFtSnhDNk8sa0JBQWdCN08sSUFBaEIsRUFBc0I7QUFDcEIsUUFBSWpYLE9BQU8sSUFBWDs7QUFDQSxRQUFJaVgsS0FBS3BQLE1BQUwsR0FBYyxDQUFsQixFQUFxQjtBQUNuQixhQUFPO0FBQUV5QyxtQkFBV3RLLEtBQUtxTTtBQUFsQixPQUFQO0FBQ0QsS0FGRCxNQUVPO0FBQ0w0TCxZQUFNaEIsS0FBSyxDQUFMLENBQU4sRUFBZThPLE1BQU1DLFFBQU4sQ0FBZUQsTUFBTUUsZUFBTixDQUFzQjtBQUNsRG5hLGdCQUFRaWEsTUFBTUMsUUFBTixDQUFlRCxNQUFNRyxLQUFOLENBQVk3bEIsTUFBWixFQUFvQnBCLFNBQXBCLENBQWYsQ0FEMEM7QUFFbERxTSxjQUFNeWEsTUFBTUMsUUFBTixDQUFlRCxNQUFNRyxLQUFOLENBQVk3bEIsTUFBWixFQUFvQjBaLEtBQXBCLEVBQTJCMVQsUUFBM0IsRUFBcUNwSCxTQUFyQyxDQUFmLENBRjRDO0FBR2xEZ0ssZUFBTzhjLE1BQU1DLFFBQU4sQ0FBZUQsTUFBTUcsS0FBTixDQUFZQyxNQUFaLEVBQW9CbG5CLFNBQXBCLENBQWYsQ0FIMkM7QUFJbERzTSxjQUFNd2EsTUFBTUMsUUFBTixDQUFlRCxNQUFNRyxLQUFOLENBQVlDLE1BQVosRUFBb0JsbkIsU0FBcEIsQ0FBZjtBQUo0QyxPQUF0QixDQUFmLENBQWY7QUFPQTtBQUNFcUwsbUJBQVd0SyxLQUFLcU07QUFEbEIsU0FFSzRLLEtBQUssQ0FBTCxDQUZMO0FBSUQ7QUFDRixHQXBLdUM7O0FBc0t4Qzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBcUJBcE8sT0FBSyxHQUFHb08sSUFBUixFQUFjO0FBQ1o7QUFDQTtBQUNBO0FBQ0EsV0FBTyxLQUFLNE0sV0FBTCxDQUFpQmhiLElBQWpCLENBQ0wsS0FBS2dkLGdCQUFMLENBQXNCNU8sSUFBdEIsQ0FESyxFQUVMLEtBQUs2TyxlQUFMLENBQXFCN08sSUFBckIsQ0FGSyxDQUFQO0FBSUQsR0FuTXVDOztBQXFNeEM7Ozs7Ozs7Ozs7Ozs7OztBQWVBak8sVUFBUSxHQUFHaU8sSUFBWCxFQUFpQjtBQUNmLFdBQU8sS0FBSzRNLFdBQUwsQ0FBaUI3YSxPQUFqQixDQUNMLEtBQUs2YyxnQkFBTCxDQUFzQjVPLElBQXRCLENBREssRUFFTCxLQUFLNk8sZUFBTCxDQUFxQjdPLElBQXJCLENBRkssQ0FBUDtBQUlEOztBQXpOdUMsQ0FBMUM7QUE0TkE1VyxPQUFPQyxNQUFQLENBQWMxQixNQUFNNkssVUFBcEIsRUFBZ0M7QUFDOUJjLGlCQUFlbUQsTUFBZixFQUF1QmxELEdBQXZCLEVBQTRCeEgsVUFBNUIsRUFBd0M7QUFDdEMsUUFBSTJMLGdCQUFnQmpCLE9BQU83QyxjQUFQLENBQXNCO0FBQ3hDMEYsYUFBTyxVQUFVMUwsRUFBVixFQUFjaUgsTUFBZCxFQUFzQjtBQUMzQnRCLFlBQUkrRixLQUFKLENBQVV2TixVQUFWLEVBQXNCNkIsRUFBdEIsRUFBMEJpSCxNQUExQjtBQUNELE9BSHVDO0FBSXhDaVMsZUFBUyxVQUFVbFosRUFBVixFQUFjaUgsTUFBZCxFQUFzQjtBQUM3QnRCLFlBQUl1VCxPQUFKLENBQVkvYSxVQUFaLEVBQXdCNkIsRUFBeEIsRUFBNEJpSCxNQUE1QjtBQUNELE9BTnVDO0FBT3hDc1IsZUFBUyxVQUFVdlksRUFBVixFQUFjO0FBQ3JCMkYsWUFBSTRTLE9BQUosQ0FBWXBhLFVBQVosRUFBd0I2QixFQUF4QjtBQUNEO0FBVHVDLEtBQXRCLENBQXBCLENBRHNDLENBYXRDO0FBQ0E7QUFFQTs7QUFDQTJGLFFBQUlrRSxNQUFKLENBQVcsWUFBWTtBQUNyQkMsb0JBQWNoTSxJQUFkO0FBQ0QsS0FGRCxFQWpCc0MsQ0FxQnRDOztBQUNBLFdBQU9nTSxhQUFQO0FBQ0QsR0F4QjZCOztBQTBCOUI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBakYsbUJBQWlCeEUsUUFBakIsRUFBMkI7QUFBRWtoQjtBQUFGLE1BQWlCLEVBQTVDLEVBQWdEO0FBQzlDO0FBQ0EsUUFBSXpoQixnQkFBZ0IwaEIsYUFBaEIsQ0FBOEJuaEIsUUFBOUIsQ0FBSixFQUNFQSxXQUFXO0FBQUNKLFdBQUtJO0FBQU4sS0FBWDs7QUFFRixRQUFJNlUsTUFBTXZjLE9BQU4sQ0FBYzBILFFBQWQsQ0FBSixFQUE2QjtBQUMzQjtBQUNBO0FBQ0EsWUFBTSxJQUFJekMsS0FBSixDQUFVLG1DQUFWLENBQU47QUFDRDs7QUFFRCxRQUFJLENBQUN5QyxRQUFELElBQWUsU0FBU0EsUUFBVixJQUF1QixDQUFDQSxTQUFTSixHQUFuRCxFQUF5RDtBQUN2RDtBQUNBLGFBQU87QUFBRUEsYUFBS3NoQixjQUFjN0MsT0FBTzFlLEVBQVA7QUFBckIsT0FBUDtBQUNEOztBQUVELFdBQU9LLFFBQVA7QUFDRDs7QUFoRDZCLENBQWhDO0FBbURBN0UsT0FBT0MsTUFBUCxDQUFjMUIsTUFBTTZLLFVBQU4sQ0FBaUJ6TCxTQUEvQixFQUEwQztBQUN4QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBOzs7Ozs7Ozs7QUFTQStHLFNBQU9qRCxHQUFQLEVBQVlDLFFBQVosRUFBc0I7QUFDcEI7QUFDQSxRQUFJLENBQUNELEdBQUwsRUFBVTtBQUNSLFlBQU0sSUFBSVcsS0FBSixDQUFVLDZCQUFWLENBQU47QUFDRCxLQUptQixDQU1wQjs7O0FBQ0FYLFVBQU16QixPQUFPMGhCLE1BQVAsQ0FDSjFoQixPQUFPaW1CLGNBQVAsQ0FBc0J4a0IsR0FBdEIsQ0FESSxFQUVKekIsT0FBT2ttQix5QkFBUCxDQUFpQ3prQixHQUFqQyxDQUZJLENBQU47O0FBS0EsUUFBSSxTQUFTQSxHQUFiLEVBQWtCO0FBQ2hCLFVBQUksQ0FBRUEsSUFBSWdELEdBQU4sSUFDQSxFQUFHLE9BQU9oRCxJQUFJZ0QsR0FBWCxLQUFtQixRQUFuQixJQUNBaEQsSUFBSWdELEdBQUosWUFBbUJsRyxNQUFNRCxRQUQ1QixDQURKLEVBRTJDO0FBQ3pDLGNBQU0sSUFBSThELEtBQUosQ0FDSiwwRUFESSxDQUFOO0FBRUQ7QUFDRixLQVBELE1BT087QUFDTCxVQUFJK2pCLGFBQWEsSUFBakIsQ0FESyxDQUdMO0FBQ0E7QUFDQTs7QUFDQSxVQUFJLEtBQUtDLG1CQUFMLEVBQUosRUFBZ0M7QUFDOUIsY0FBTUMsWUFBWXJELElBQUlzRCx3QkFBSixDQUE2QmhqQixHQUE3QixFQUFsQjs7QUFDQSxZQUFJLENBQUMraUIsU0FBTCxFQUFnQjtBQUNkRix1QkFBYSxLQUFiO0FBQ0Q7QUFDRjs7QUFFRCxVQUFJQSxVQUFKLEVBQWdCO0FBQ2Qxa0IsWUFBSWdELEdBQUosR0FBVSxLQUFLcWUsVUFBTCxFQUFWO0FBQ0Q7QUFDRixLQW5DbUIsQ0FxQ3BCO0FBQ0E7OztBQUNBLFFBQUl5RCx3Q0FBd0MsVUFBVXppQixNQUFWLEVBQWtCO0FBQzVELFVBQUlyQyxJQUFJZ0QsR0FBUixFQUFhO0FBQ1gsZUFBT2hELElBQUlnRCxHQUFYO0FBQ0QsT0FIMkQsQ0FLNUQ7QUFDQTtBQUNBOzs7QUFDQWhELFVBQUlnRCxHQUFKLEdBQVVYLE1BQVY7QUFFQSxhQUFPQSxNQUFQO0FBQ0QsS0FYRDs7QUFhQSxVQUFNcUIsa0JBQWtCcWhCLGFBQ3RCOWtCLFFBRHNCLEVBQ1o2a0IscUNBRFksQ0FBeEI7O0FBR0EsUUFBSSxLQUFLSCxtQkFBTCxFQUFKLEVBQWdDO0FBQzlCLFlBQU10aUIsU0FBUyxLQUFLMmlCLGtCQUFMLENBQXdCLFFBQXhCLEVBQWtDLENBQUNobEIsR0FBRCxDQUFsQyxFQUF5QzBELGVBQXpDLENBQWY7O0FBQ0EsYUFBT29oQixzQ0FBc0N6aUIsTUFBdEMsQ0FBUDtBQUNELEtBMURtQixDQTREcEI7QUFDQTs7O0FBQ0EsUUFBSTtBQUNGO0FBQ0E7QUFDQTtBQUNBLFlBQU1BLFNBQVMsS0FBSzBmLFdBQUwsQ0FBaUI5ZSxNQUFqQixDQUF3QmpELEdBQXhCLEVBQTZCMEQsZUFBN0IsQ0FBZjs7QUFDQSxhQUFPb2hCLHNDQUFzQ3ppQixNQUF0QyxDQUFQO0FBQ0QsS0FORCxDQU1FLE9BQU9NLENBQVAsRUFBVTtBQUNWLFVBQUkxQyxRQUFKLEVBQWM7QUFDWkEsaUJBQVMwQyxDQUFUO0FBQ0EsZUFBTyxJQUFQO0FBQ0Q7O0FBQ0QsWUFBTUEsQ0FBTjtBQUNEO0FBQ0YsR0FuSHVDOztBQXFIeEM7Ozs7Ozs7Ozs7Ozs7QUFhQWdELFNBQU92QyxRQUFQLEVBQWlCc2MsUUFBakIsRUFBMkIsR0FBR3VGLGtCQUE5QixFQUFrRDtBQUNoRCxVQUFNaGxCLFdBQVdpbEIsb0JBQW9CRCxrQkFBcEIsQ0FBakIsQ0FEZ0QsQ0FHaEQ7QUFDQTs7QUFDQSxVQUFNaG5CLHVCQUFnQmduQixtQkFBbUIsQ0FBbkIsS0FBeUIsSUFBekMsQ0FBTjs7QUFDQSxRQUFJN2YsVUFBSjs7QUFDQSxRQUFJbkgsV0FBV0EsUUFBUXdHLE1BQXZCLEVBQStCO0FBQzdCO0FBQ0EsVUFBSXhHLFFBQVFtSCxVQUFaLEVBQXdCO0FBQ3RCLFlBQUksRUFBRSxPQUFPbkgsUUFBUW1ILFVBQWYsS0FBOEIsUUFBOUIsSUFBMENuSCxRQUFRbUgsVUFBUixZQUE4QnRJLE1BQU1ELFFBQWhGLENBQUosRUFDRSxNQUFNLElBQUk4RCxLQUFKLENBQVUsdUNBQVYsQ0FBTjtBQUNGeUUscUJBQWFuSCxRQUFRbUgsVUFBckI7QUFDRCxPQUpELE1BSU8sSUFBSSxDQUFDaEMsUUFBRCxJQUFhLENBQUNBLFNBQVNKLEdBQTNCLEVBQWdDO0FBQ3JDb0MscUJBQWEsS0FBS2ljLFVBQUwsRUFBYjtBQUNBcGpCLGdCQUFRb0gsV0FBUixHQUFzQixJQUF0QjtBQUNBcEgsZ0JBQVFtSCxVQUFSLEdBQXFCQSxVQUFyQjtBQUNEO0FBQ0Y7O0FBRURoQyxlQUNFdEcsTUFBTTZLLFVBQU4sQ0FBaUJDLGdCQUFqQixDQUFrQ3hFLFFBQWxDLEVBQTRDO0FBQUVraEIsa0JBQVlsZjtBQUFkLEtBQTVDLENBREY7QUFHQSxVQUFNMUIsa0JBQWtCcWhCLGFBQWE5a0IsUUFBYixDQUF4Qjs7QUFFQSxRQUFJLEtBQUswa0IsbUJBQUwsRUFBSixFQUFnQztBQUM5QixZQUFNeFAsT0FBTyxDQUNYL1IsUUFEVyxFQUVYc2MsUUFGVyxFQUdYemhCLE9BSFcsQ0FBYjtBQU1BLGFBQU8sS0FBSyttQixrQkFBTCxDQUF3QixRQUF4QixFQUFrQzdQLElBQWxDLEVBQXdDelIsZUFBeEMsQ0FBUDtBQUNELEtBakMrQyxDQW1DaEQ7QUFDQTs7O0FBQ0EsUUFBSTtBQUNGO0FBQ0E7QUFDQTtBQUNBLGFBQU8sS0FBS3FlLFdBQUwsQ0FBaUJwYyxNQUFqQixDQUNMdkMsUUFESyxFQUNLc2MsUUFETCxFQUNlemhCLE9BRGYsRUFDd0J5RixlQUR4QixDQUFQO0FBRUQsS0FORCxDQU1FLE9BQU9mLENBQVAsRUFBVTtBQUNWLFVBQUkxQyxRQUFKLEVBQWM7QUFDWkEsaUJBQVMwQyxDQUFUO0FBQ0EsZUFBTyxJQUFQO0FBQ0Q7O0FBQ0QsWUFBTUEsQ0FBTjtBQUNEO0FBQ0YsR0FwTHVDOztBQXNMeEM7Ozs7Ozs7OztBQVNBbUIsU0FBT1YsUUFBUCxFQUFpQm5ELFFBQWpCLEVBQTJCO0FBQ3pCbUQsZUFBV3RHLE1BQU02SyxVQUFOLENBQWlCQyxnQkFBakIsQ0FBa0N4RSxRQUFsQyxDQUFYO0FBRUEsVUFBTU0sa0JBQWtCcWhCLGFBQWE5a0IsUUFBYixDQUF4Qjs7QUFFQSxRQUFJLEtBQUswa0IsbUJBQUwsRUFBSixFQUFnQztBQUM5QixhQUFPLEtBQUtLLGtCQUFMLENBQXdCLFFBQXhCLEVBQWtDLENBQUM1aEIsUUFBRCxDQUFsQyxFQUE4Q00sZUFBOUMsQ0FBUDtBQUNELEtBUHdCLENBU3pCO0FBQ0E7OztBQUNBLFFBQUk7QUFDRjtBQUNBO0FBQ0E7QUFDQSxhQUFPLEtBQUtxZSxXQUFMLENBQWlCamUsTUFBakIsQ0FBd0JWLFFBQXhCLEVBQWtDTSxlQUFsQyxDQUFQO0FBQ0QsS0FMRCxDQUtFLE9BQU9mLENBQVAsRUFBVTtBQUNWLFVBQUkxQyxRQUFKLEVBQWM7QUFDWkEsaUJBQVMwQyxDQUFUO0FBQ0EsZUFBTyxJQUFQO0FBQ0Q7O0FBQ0QsWUFBTUEsQ0FBTjtBQUNEO0FBQ0YsR0F0TnVDOztBQXdOeEM7QUFDQTtBQUNBZ2lCLHdCQUFzQjtBQUNwQjtBQUNBLFdBQU8sS0FBSy9DLFdBQUwsSUFBb0IsS0FBS0EsV0FBTCxLQUFxQnBpQixPQUFPc2lCLE1BQXZEO0FBQ0QsR0E3TnVDOztBQStOeEM7Ozs7Ozs7OztBQVNBcmQsU0FBT3JCLFFBQVAsRUFBaUJzYyxRQUFqQixFQUEyQnpoQixPQUEzQixFQUFvQ2dDLFFBQXBDLEVBQThDO0FBQzVDLFFBQUksQ0FBRUEsUUFBRixJQUFjLE9BQU9oQyxPQUFQLEtBQW1CLFVBQXJDLEVBQWlEO0FBQy9DZ0MsaUJBQVdoQyxPQUFYO0FBQ0FBLGdCQUFVLEVBQVY7QUFDRDs7QUFFRCxXQUFPLEtBQUswSCxNQUFMLENBQVl2QyxRQUFaLEVBQXNCc2MsUUFBdEIsZUFDRnpoQixPQURFO0FBRUx1SCxxQkFBZSxJQUZWO0FBR0xmLGNBQVE7QUFISCxRQUlKeEUsUUFKSSxDQUFQO0FBS0QsR0FuUHVDOztBQXFQeEM7QUFDQTtBQUNBb0gsZUFBYUMsS0FBYixFQUFvQnJKLE9BQXBCLEVBQTZCO0FBQzNCLFFBQUlDLE9BQU8sSUFBWDtBQUNBLFFBQUksQ0FBQ0EsS0FBSzZqQixXQUFMLENBQWlCMWEsWUFBdEIsRUFDRSxNQUFNLElBQUkxRyxLQUFKLENBQVUsa0RBQVYsQ0FBTjs7QUFDRnpDLFNBQUs2akIsV0FBTCxDQUFpQjFhLFlBQWpCLENBQThCQyxLQUE5QixFQUFxQ3JKLE9BQXJDO0FBQ0QsR0E1UHVDOztBQThQeEN3SixhQUFXSCxLQUFYLEVBQWtCO0FBQ2hCLFFBQUlwSixPQUFPLElBQVg7QUFDQSxRQUFJLENBQUNBLEtBQUs2akIsV0FBTCxDQUFpQnRhLFVBQXRCLEVBQ0UsTUFBTSxJQUFJOUcsS0FBSixDQUFVLGdEQUFWLENBQU47O0FBQ0Z6QyxTQUFLNmpCLFdBQUwsQ0FBaUJ0YSxVQUFqQixDQUE0QkgsS0FBNUI7QUFDRCxHQW5RdUM7O0FBcVF4Q3ZELG9CQUFrQjtBQUNoQixRQUFJN0YsT0FBTyxJQUFYO0FBQ0EsUUFBSSxDQUFDQSxLQUFLNmpCLFdBQUwsQ0FBaUI5ZCxjQUF0QixFQUNFLE1BQU0sSUFBSXRELEtBQUosQ0FBVSxxREFBVixDQUFOOztBQUNGekMsU0FBSzZqQixXQUFMLENBQWlCOWQsY0FBakI7QUFDRCxHQTFRdUM7O0FBNFF4QzlDLDBCQUF3QkMsUUFBeEIsRUFBa0NDLFlBQWxDLEVBQWdEO0FBQzlDLFFBQUluRCxPQUFPLElBQVg7QUFDQSxRQUFJLENBQUNBLEtBQUs2akIsV0FBTCxDQUFpQjVnQix1QkFBdEIsRUFDRSxNQUFNLElBQUlSLEtBQUosQ0FBVSw2REFBVixDQUFOOztBQUNGekMsU0FBSzZqQixXQUFMLENBQWlCNWdCLHVCQUFqQixDQUF5Q0MsUUFBekMsRUFBbURDLFlBQW5EO0FBQ0QsR0FqUnVDOztBQW1SeEM7Ozs7QUFJQU4sa0JBQWdCO0FBQ2QsUUFBSTdDLE9BQU8sSUFBWDs7QUFDQSxRQUFJLENBQUVBLEtBQUs2akIsV0FBTCxDQUFpQmhoQixhQUF2QixFQUFzQztBQUNwQyxZQUFNLElBQUlKLEtBQUosQ0FBVSxtREFBVixDQUFOO0FBQ0Q7O0FBQ0QsV0FBT3pDLEtBQUs2akIsV0FBTCxDQUFpQmhoQixhQUFqQixFQUFQO0FBQ0QsR0E3UnVDOztBQStSeEM7Ozs7QUFJQW9rQixnQkFBYztBQUNaLFFBQUlqbkIsT0FBTyxJQUFYOztBQUNBLFFBQUksRUFBR0EsS0FBS2lqQixPQUFMLENBQWF0WixLQUFiLElBQXNCM0osS0FBS2lqQixPQUFMLENBQWF0WixLQUFiLENBQW1CM0ksRUFBNUMsQ0FBSixFQUFxRDtBQUNuRCxZQUFNLElBQUl5QixLQUFKLENBQVUsaURBQVYsQ0FBTjtBQUNEOztBQUNELFdBQU96QyxLQUFLaWpCLE9BQUwsQ0FBYXRaLEtBQWIsQ0FBbUIzSSxFQUExQjtBQUNEOztBQXpTdUMsQ0FBMUMsRSxDQTRTQTs7QUFDQSxTQUFTNmxCLFlBQVQsQ0FBc0I5a0IsUUFBdEIsRUFBZ0NtbEIsYUFBaEMsRUFBK0M7QUFDN0MsU0FBT25sQixZQUFZLFVBQVVzRixLQUFWLEVBQWlCbEQsTUFBakIsRUFBeUI7QUFDMUMsUUFBSWtELEtBQUosRUFBVztBQUNUdEYsZUFBU3NGLEtBQVQ7QUFDRCxLQUZELE1BRU8sSUFBSSxPQUFPNmYsYUFBUCxLQUF5QixVQUE3QixFQUF5QztBQUM5Q25sQixlQUFTLElBQVQsRUFBZW1sQixjQUFjL2lCLE1BQWQsQ0FBZjtBQUNELEtBRk0sTUFFQTtBQUNMcEMsZUFBUyxJQUFULEVBQWVvQyxNQUFmO0FBQ0Q7QUFDRixHQVJEO0FBU0Q7QUFFRDs7Ozs7Ozs7QUFNQXZGLE1BQU1ELFFBQU4sR0FBaUJvbUIsUUFBUXBtQixRQUF6QjtBQUVBOzs7Ozs7QUFLQUMsTUFBTWtLLE1BQU4sR0FBZW5FLGdCQUFnQm1FLE1BQS9CO0FBRUE7Ozs7QUFHQWxLLE1BQU02SyxVQUFOLENBQWlCWCxNQUFqQixHQUEwQmxLLE1BQU1rSyxNQUFoQztBQUVBOzs7O0FBR0FsSyxNQUFNNkssVUFBTixDQUFpQjlLLFFBQWpCLEdBQTRCQyxNQUFNRCxRQUFsQztBQUVBOzs7O0FBR0EyQyxPQUFPbUksVUFBUCxHQUFvQjdLLE1BQU02SyxVQUExQixDLENBRUE7O0FBQ0FwSixPQUFPQyxNQUFQLENBQ0VnQixPQUFPbUksVUFBUCxDQUFrQnpMLFNBRHBCLEVBRUVtcEIsVUFBVUMsbUJBRlo7O0FBS0EsU0FBU0osbUJBQVQsQ0FBNkIvUCxJQUE3QixFQUFtQztBQUNqQztBQUNBO0FBQ0EsTUFBSUEsS0FBS3BQLE1BQUwsS0FDQ29QLEtBQUtBLEtBQUtwUCxNQUFMLEdBQWMsQ0FBbkIsTUFBMEI1SSxTQUExQixJQUNBZ1ksS0FBS0EsS0FBS3BQLE1BQUwsR0FBYyxDQUFuQixhQUFpQ3hCLFFBRmxDLENBQUosRUFFaUQ7QUFDL0MsV0FBTzRRLEtBQUt0QyxHQUFMLEVBQVA7QUFDRDtBQUNGLEM7Ozs7Ozs7Ozs7O0FDN3ZCRDs7Ozs7O0FBTUEvVixNQUFNeW9CLG9CQUFOLEdBQTZCLFNBQVNBLG9CQUFULENBQStCdG5CLE9BQS9CLEVBQXdDO0FBQ25Fa1ksUUFBTWxZLE9BQU4sRUFBZU0sTUFBZjtBQUNBekIsUUFBTStCLGtCQUFOLEdBQTJCWixPQUEzQjtBQUNELENBSEQsQyIsImZpbGUiOiIvcGFja2FnZXMvbW9uZ28uanMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFByb3ZpZGUgYSBzeW5jaHJvbm91cyBDb2xsZWN0aW9uIEFQSSB1c2luZyBmaWJlcnMsIGJhY2tlZCBieVxuICogTW9uZ29EQi4gIFRoaXMgaXMgb25seSBmb3IgdXNlIG9uIHRoZSBzZXJ2ZXIsIGFuZCBtb3N0bHkgaWRlbnRpY2FsXG4gKiB0byB0aGUgY2xpZW50IEFQSS5cbiAqXG4gKiBOT1RFOiB0aGUgcHVibGljIEFQSSBtZXRob2RzIG11c3QgYmUgcnVuIHdpdGhpbiBhIGZpYmVyLiBJZiB5b3UgY2FsbFxuICogdGhlc2Ugb3V0c2lkZSBvZiBhIGZpYmVyIHRoZXkgd2lsbCBleHBsb2RlIVxuICovXG5cbnZhciBNb25nb0RCID0gTnBtTW9kdWxlTW9uZ29kYjtcbnZhciBGdXR1cmUgPSBOcG0ucmVxdWlyZSgnZmliZXJzL2Z1dHVyZScpO1xuXG5Nb25nb0ludGVybmFscyA9IHt9O1xuTW9uZ29UZXN0ID0ge307XG5cbk1vbmdvSW50ZXJuYWxzLk5wbU1vZHVsZXMgPSB7XG4gIG1vbmdvZGI6IHtcbiAgICB2ZXJzaW9uOiBOcG1Nb2R1bGVNb25nb2RiVmVyc2lvbixcbiAgICBtb2R1bGU6IE1vbmdvREJcbiAgfVxufTtcblxuLy8gT2xkZXIgdmVyc2lvbiBvZiB3aGF0IGlzIG5vdyBhdmFpbGFibGUgdmlhXG4vLyBNb25nb0ludGVybmFscy5OcG1Nb2R1bGVzLm1vbmdvZGIubW9kdWxlLiAgSXQgd2FzIG5ldmVyIGRvY3VtZW50ZWQsIGJ1dFxuLy8gcGVvcGxlIGRvIHVzZSBpdC5cbi8vIFhYWCBDT01QQVQgV0lUSCAxLjAuMy4yXG5Nb25nb0ludGVybmFscy5OcG1Nb2R1bGUgPSBNb25nb0RCO1xuXG4vLyBUaGlzIGlzIHVzZWQgdG8gYWRkIG9yIHJlbW92ZSBFSlNPTiBmcm9tIHRoZSBiZWdpbm5pbmcgb2YgZXZlcnl0aGluZyBuZXN0ZWRcbi8vIGluc2lkZSBhbiBFSlNPTiBjdXN0b20gdHlwZS4gSXQgc2hvdWxkIG9ubHkgYmUgY2FsbGVkIG9uIHB1cmUgSlNPTiFcbnZhciByZXBsYWNlTmFtZXMgPSBmdW5jdGlvbiAoZmlsdGVyLCB0aGluZykge1xuICBpZiAodHlwZW9mIHRoaW5nID09PSBcIm9iamVjdFwiKSB7XG4gICAgaWYgKF8uaXNBcnJheSh0aGluZykpIHtcbiAgICAgIHJldHVybiBfLm1hcCh0aGluZywgXy5iaW5kKHJlcGxhY2VOYW1lcywgbnVsbCwgZmlsdGVyKSk7XG4gICAgfVxuICAgIHZhciByZXQgPSB7fTtcbiAgICBfLmVhY2godGhpbmcsIGZ1bmN0aW9uICh2YWx1ZSwga2V5KSB7XG4gICAgICByZXRbZmlsdGVyKGtleSldID0gcmVwbGFjZU5hbWVzKGZpbHRlciwgdmFsdWUpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXQ7XG4gIH1cbiAgcmV0dXJuIHRoaW5nO1xufTtcblxuLy8gRW5zdXJlIHRoYXQgRUpTT04uY2xvbmUga2VlcHMgYSBUaW1lc3RhbXAgYXMgYSBUaW1lc3RhbXAgKGluc3RlYWQgb2YganVzdFxuLy8gZG9pbmcgYSBzdHJ1Y3R1cmFsIGNsb25lKS5cbi8vIFhYWCBob3cgb2sgaXMgdGhpcz8gd2hhdCBpZiB0aGVyZSBhcmUgbXVsdGlwbGUgY29waWVzIG9mIE1vbmdvREIgbG9hZGVkP1xuTW9uZ29EQi5UaW1lc3RhbXAucHJvdG90eXBlLmNsb25lID0gZnVuY3Rpb24gKCkge1xuICAvLyBUaW1lc3RhbXBzIHNob3VsZCBiZSBpbW11dGFibGUuXG4gIHJldHVybiB0aGlzO1xufTtcblxudmFyIG1ha2VNb25nb0xlZ2FsID0gZnVuY3Rpb24gKG5hbWUpIHsgcmV0dXJuIFwiRUpTT05cIiArIG5hbWU7IH07XG52YXIgdW5tYWtlTW9uZ29MZWdhbCA9IGZ1bmN0aW9uIChuYW1lKSB7IHJldHVybiBuYW1lLnN1YnN0cig1KTsgfTtcblxudmFyIHJlcGxhY2VNb25nb0F0b21XaXRoTWV0ZW9yID0gZnVuY3Rpb24gKGRvY3VtZW50KSB7XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvREIuQmluYXJ5KSB7XG4gICAgdmFyIGJ1ZmZlciA9IGRvY3VtZW50LnZhbHVlKHRydWUpO1xuICAgIHJldHVybiBuZXcgVWludDhBcnJheShidWZmZXIpO1xuICB9XG4gIGlmIChkb2N1bWVudCBpbnN0YW5jZW9mIE1vbmdvREIuT2JqZWN0SUQpIHtcbiAgICByZXR1cm4gbmV3IE1vbmdvLk9iamVjdElEKGRvY3VtZW50LnRvSGV4U3RyaW5nKCkpO1xuICB9XG4gIGlmIChkb2N1bWVudFtcIkVKU09OJHR5cGVcIl0gJiYgZG9jdW1lbnRbXCJFSlNPTiR2YWx1ZVwiXSAmJiBfLnNpemUoZG9jdW1lbnQpID09PSAyKSB7XG4gICAgcmV0dXJuIEVKU09OLmZyb21KU09OVmFsdWUocmVwbGFjZU5hbWVzKHVubWFrZU1vbmdvTGVnYWwsIGRvY3VtZW50KSk7XG4gIH1cbiAgaWYgKGRvY3VtZW50IGluc3RhbmNlb2YgTW9uZ29EQi5UaW1lc3RhbXApIHtcbiAgICAvLyBGb3Igbm93LCB0aGUgTWV0ZW9yIHJlcHJlc2VudGF0aW9uIG9mIGEgTW9uZ28gdGltZXN0YW1wIHR5cGUgKG5vdCBhIGRhdGUhXG4gICAgLy8gdGhpcyBpcyBhIHdlaXJkIGludGVybmFsIHRoaW5nIHVzZWQgaW4gdGhlIG9wbG9nISkgaXMgdGhlIHNhbWUgYXMgdGhlXG4gICAgLy8gTW9uZ28gcmVwcmVzZW50YXRpb24uIFdlIG5lZWQgdG8gZG8gdGhpcyBleHBsaWNpdGx5IG9yIGVsc2Ugd2Ugd291bGQgZG8gYVxuICAgIC8vIHN0cnVjdHVyYWwgY2xvbmUgYW5kIGxvc2UgdGhlIHByb3RvdHlwZS5cbiAgICByZXR1cm4gZG9jdW1lbnQ7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn07XG5cbnZhciByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyA9IGZ1bmN0aW9uIChkb2N1bWVudCkge1xuICBpZiAoRUpTT04uaXNCaW5hcnkoZG9jdW1lbnQpKSB7XG4gICAgLy8gVGhpcyBkb2VzIG1vcmUgY29waWVzIHRoYW4gd2UnZCBsaWtlLCBidXQgaXMgbmVjZXNzYXJ5IGJlY2F1c2VcbiAgICAvLyBNb25nb0RCLkJTT04gb25seSBsb29rcyBsaWtlIGl0IHRha2VzIGEgVWludDhBcnJheSAoYW5kIGRvZXNuJ3QgYWN0dWFsbHlcbiAgICAvLyBzZXJpYWxpemUgaXQgY29ycmVjdGx5KS5cbiAgICByZXR1cm4gbmV3IE1vbmdvREIuQmluYXJ5KEJ1ZmZlci5mcm9tKGRvY3VtZW50KSk7XG4gIH1cbiAgaWYgKGRvY3VtZW50IGluc3RhbmNlb2YgTW9uZ28uT2JqZWN0SUQpIHtcbiAgICByZXR1cm4gbmV3IE1vbmdvREIuT2JqZWN0SUQoZG9jdW1lbnQudG9IZXhTdHJpbmcoKSk7XG4gIH1cbiAgaWYgKGRvY3VtZW50IGluc3RhbmNlb2YgTW9uZ29EQi5UaW1lc3RhbXApIHtcbiAgICAvLyBGb3Igbm93LCB0aGUgTWV0ZW9yIHJlcHJlc2VudGF0aW9uIG9mIGEgTW9uZ28gdGltZXN0YW1wIHR5cGUgKG5vdCBhIGRhdGUhXG4gICAgLy8gdGhpcyBpcyBhIHdlaXJkIGludGVybmFsIHRoaW5nIHVzZWQgaW4gdGhlIG9wbG9nISkgaXMgdGhlIHNhbWUgYXMgdGhlXG4gICAgLy8gTW9uZ28gcmVwcmVzZW50YXRpb24uIFdlIG5lZWQgdG8gZG8gdGhpcyBleHBsaWNpdGx5IG9yIGVsc2Ugd2Ugd291bGQgZG8gYVxuICAgIC8vIHN0cnVjdHVyYWwgY2xvbmUgYW5kIGxvc2UgdGhlIHByb3RvdHlwZS5cbiAgICByZXR1cm4gZG9jdW1lbnQ7XG4gIH1cbiAgaWYgKEVKU09OLl9pc0N1c3RvbVR5cGUoZG9jdW1lbnQpKSB7XG4gICAgcmV0dXJuIHJlcGxhY2VOYW1lcyhtYWtlTW9uZ29MZWdhbCwgRUpTT04udG9KU09OVmFsdWUoZG9jdW1lbnQpKTtcbiAgfVxuICAvLyBJdCBpcyBub3Qgb3JkaW5hcmlseSBwb3NzaWJsZSB0byBzdGljayBkb2xsYXItc2lnbiBrZXlzIGludG8gbW9uZ29cbiAgLy8gc28gd2UgZG9uJ3QgYm90aGVyIGNoZWNraW5nIGZvciB0aGluZ3MgdGhhdCBuZWVkIGVzY2FwaW5nIGF0IHRoaXMgdGltZS5cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn07XG5cbnZhciByZXBsYWNlVHlwZXMgPSBmdW5jdGlvbiAoZG9jdW1lbnQsIGF0b21UcmFuc2Zvcm1lcikge1xuICBpZiAodHlwZW9mIGRvY3VtZW50ICE9PSAnb2JqZWN0JyB8fCBkb2N1bWVudCA9PT0gbnVsbClcbiAgICByZXR1cm4gZG9jdW1lbnQ7XG5cbiAgdmFyIHJlcGxhY2VkVG9wTGV2ZWxBdG9tID0gYXRvbVRyYW5zZm9ybWVyKGRvY3VtZW50KTtcbiAgaWYgKHJlcGxhY2VkVG9wTGV2ZWxBdG9tICE9PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHJlcGxhY2VkVG9wTGV2ZWxBdG9tO1xuXG4gIHZhciByZXQgPSBkb2N1bWVudDtcbiAgXy5lYWNoKGRvY3VtZW50LCBmdW5jdGlvbiAodmFsLCBrZXkpIHtcbiAgICB2YXIgdmFsUmVwbGFjZWQgPSByZXBsYWNlVHlwZXModmFsLCBhdG9tVHJhbnNmb3JtZXIpO1xuICAgIGlmICh2YWwgIT09IHZhbFJlcGxhY2VkKSB7XG4gICAgICAvLyBMYXp5IGNsb25lLiBTaGFsbG93IGNvcHkuXG4gICAgICBpZiAocmV0ID09PSBkb2N1bWVudClcbiAgICAgICAgcmV0ID0gXy5jbG9uZShkb2N1bWVudCk7XG4gICAgICByZXRba2V5XSA9IHZhbFJlcGxhY2VkO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiByZXQ7XG59O1xuXG5cbk1vbmdvQ29ubmVjdGlvbiA9IGZ1bmN0aW9uICh1cmwsIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgc2VsZi5fb2JzZXJ2ZU11bHRpcGxleGVycyA9IHt9O1xuICBzZWxmLl9vbkZhaWxvdmVySG9vayA9IG5ldyBIb29rO1xuXG4gIHZhciBtb25nb09wdGlvbnMgPSBPYmplY3QuYXNzaWduKHtcbiAgICAvLyBSZWNvbm5lY3Qgb24gZXJyb3IuXG4gICAgYXV0b1JlY29ubmVjdDogdHJ1ZSxcbiAgICAvLyBUcnkgdG8gcmVjb25uZWN0IGZvcmV2ZXIsIGluc3RlYWQgb2Ygc3RvcHBpbmcgYWZ0ZXIgMzAgdHJpZXMgKHRoZVxuICAgIC8vIGRlZmF1bHQpLCB3aXRoIGVhY2ggYXR0ZW1wdCBzZXBhcmF0ZWQgYnkgMTAwMG1zLlxuICAgIHJlY29ubmVjdFRyaWVzOiBJbmZpbml0eSxcbiAgICBpZ25vcmVVbmRlZmluZWQ6IHRydWVcbiAgfSwgTW9uZ28uX2Nvbm5lY3Rpb25PcHRpb25zKTtcblxuICAvLyBEaXNhYmxlIHRoZSBuYXRpdmUgcGFyc2VyIGJ5IGRlZmF1bHQsIHVubGVzcyBzcGVjaWZpY2FsbHkgZW5hYmxlZFxuICAvLyBpbiB0aGUgbW9uZ28gVVJMLlxuICAvLyAtIFRoZSBuYXRpdmUgZHJpdmVyIGNhbiBjYXVzZSBlcnJvcnMgd2hpY2ggbm9ybWFsbHkgd291bGQgYmVcbiAgLy8gICB0aHJvd24sIGNhdWdodCwgYW5kIGhhbmRsZWQgaW50byBzZWdmYXVsdHMgdGhhdCB0YWtlIGRvd24gdGhlXG4gIC8vICAgd2hvbGUgYXBwLlxuICAvLyAtIEJpbmFyeSBtb2R1bGVzIGRvbid0IHlldCB3b3JrIHdoZW4geW91IGJ1bmRsZSBhbmQgbW92ZSB0aGUgYnVuZGxlXG4gIC8vICAgdG8gYSBkaWZmZXJlbnQgcGxhdGZvcm0gKGFrYSBkZXBsb3kpXG4gIC8vIFdlIHNob3VsZCByZXZpc2l0IHRoaXMgYWZ0ZXIgYmluYXJ5IG5wbSBtb2R1bGUgc3VwcG9ydCBsYW5kcy5cbiAgaWYgKCEoL1tcXD8mXW5hdGl2ZV8/W3BQXWFyc2VyPS8udGVzdCh1cmwpKSkge1xuICAgIG1vbmdvT3B0aW9ucy5uYXRpdmVfcGFyc2VyID0gZmFsc2U7XG4gIH1cblxuICAvLyBJbnRlcm5hbGx5IHRoZSBvcGxvZyBjb25uZWN0aW9ucyBzcGVjaWZ5IHRoZWlyIG93biBwb29sU2l6ZVxuICAvLyB3aGljaCB3ZSBkb24ndCB3YW50IHRvIG92ZXJ3cml0ZSB3aXRoIGFueSB1c2VyIGRlZmluZWQgdmFsdWVcbiAgaWYgKF8uaGFzKG9wdGlvbnMsICdwb29sU2l6ZScpKSB7XG4gICAgLy8gSWYgd2UganVzdCBzZXQgdGhpcyBmb3IgXCJzZXJ2ZXJcIiwgcmVwbFNldCB3aWxsIG92ZXJyaWRlIGl0LiBJZiB3ZSBqdXN0XG4gICAgLy8gc2V0IGl0IGZvciByZXBsU2V0LCBpdCB3aWxsIGJlIGlnbm9yZWQgaWYgd2UncmUgbm90IHVzaW5nIGEgcmVwbFNldC5cbiAgICBtb25nb09wdGlvbnMucG9vbFNpemUgPSBvcHRpb25zLnBvb2xTaXplO1xuICB9XG5cbiAgc2VsZi5kYiA9IG51bGw7XG4gIC8vIFdlIGtlZXAgdHJhY2sgb2YgdGhlIFJlcGxTZXQncyBwcmltYXJ5LCBzbyB0aGF0IHdlIGNhbiB0cmlnZ2VyIGhvb2tzIHdoZW5cbiAgLy8gaXQgY2hhbmdlcy4gIFRoZSBOb2RlIGRyaXZlcidzIGpvaW5lZCBjYWxsYmFjayBzZWVtcyB0byBmaXJlIHdheSB0b29cbiAgLy8gb2Z0ZW4sIHdoaWNoIGlzIHdoeSB3ZSBuZWVkIHRvIHRyYWNrIGl0IG91cnNlbHZlcy5cbiAgc2VsZi5fcHJpbWFyeSA9IG51bGw7XG4gIHNlbGYuX29wbG9nSGFuZGxlID0gbnVsbDtcbiAgc2VsZi5fZG9jRmV0Y2hlciA9IG51bGw7XG5cblxuICB2YXIgY29ubmVjdEZ1dHVyZSA9IG5ldyBGdXR1cmU7XG4gIE1vbmdvREIuY29ubmVjdChcbiAgICB1cmwsXG4gICAgbW9uZ29PcHRpb25zLFxuICAgIE1ldGVvci5iaW5kRW52aXJvbm1lbnQoXG4gICAgICBmdW5jdGlvbiAoZXJyLCBkYikge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRmlyc3QsIGZpZ3VyZSBvdXQgd2hhdCB0aGUgY3VycmVudCBwcmltYXJ5IGlzLCBpZiBhbnkuXG4gICAgICAgIGlmIChkYi5zZXJ2ZXJDb25maWcuaXNNYXN0ZXJEb2MpIHtcbiAgICAgICAgICBzZWxmLl9wcmltYXJ5ID0gZGIuc2VydmVyQ29uZmlnLmlzTWFzdGVyRG9jLnByaW1hcnk7XG4gICAgICAgIH1cblxuICAgICAgICBkYi5zZXJ2ZXJDb25maWcub24oXG4gICAgICAgICAgJ2pvaW5lZCcsIE1ldGVvci5iaW5kRW52aXJvbm1lbnQoZnVuY3Rpb24gKGtpbmQsIGRvYykge1xuICAgICAgICAgICAgaWYgKGtpbmQgPT09ICdwcmltYXJ5Jykge1xuICAgICAgICAgICAgICBpZiAoZG9jLnByaW1hcnkgIT09IHNlbGYuX3ByaW1hcnkpIHtcbiAgICAgICAgICAgICAgICBzZWxmLl9wcmltYXJ5ID0gZG9jLnByaW1hcnk7XG4gICAgICAgICAgICAgICAgc2VsZi5fb25GYWlsb3Zlckhvb2suZWFjaChmdW5jdGlvbiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChkb2MubWUgPT09IHNlbGYuX3ByaW1hcnkpIHtcbiAgICAgICAgICAgICAgLy8gVGhlIHRoaW5nIHdlIHRob3VnaHQgd2FzIHByaW1hcnkgaXMgbm93IHNvbWV0aGluZyBvdGhlciB0aGFuXG4gICAgICAgICAgICAgIC8vIHByaW1hcnkuICBGb3JnZXQgdGhhdCB3ZSB0aG91Z2h0IGl0IHdhcyBwcmltYXJ5LiAgKFRoaXMgbWVhbnNcbiAgICAgICAgICAgICAgLy8gdGhhdCBpZiBhIHNlcnZlciBzdG9wcyBiZWluZyBwcmltYXJ5IGFuZCB0aGVuIHN0YXJ0cyBiZWluZ1xuICAgICAgICAgICAgICAvLyBwcmltYXJ5IGFnYWluIHdpdGhvdXQgYW5vdGhlciBzZXJ2ZXIgYmVjb21pbmcgcHJpbWFyeSBpbiB0aGVcbiAgICAgICAgICAgICAgLy8gbWlkZGxlLCB3ZSdsbCBjb3JyZWN0bHkgY291bnQgaXQgYXMgYSBmYWlsb3Zlci4pXG4gICAgICAgICAgICAgIHNlbGYuX3ByaW1hcnkgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pKTtcblxuICAgICAgICAvLyBBbGxvdyB0aGUgY29uc3RydWN0b3IgdG8gcmV0dXJuLlxuICAgICAgICBjb25uZWN0RnV0dXJlWydyZXR1cm4nXShkYik7XG4gICAgICB9LFxuICAgICAgY29ubmVjdEZ1dHVyZS5yZXNvbHZlcigpICAvLyBvbkV4Y2VwdGlvblxuICAgIClcbiAgKTtcblxuICAvLyBXYWl0IGZvciB0aGUgY29ubmVjdGlvbiB0byBiZSBzdWNjZXNzZnVsOyB0aHJvd3Mgb24gZmFpbHVyZS5cbiAgc2VsZi5kYiA9IGNvbm5lY3RGdXR1cmUud2FpdCgpO1xuXG4gIGlmIChvcHRpb25zLm9wbG9nVXJsICYmICEgUGFja2FnZVsnZGlzYWJsZS1vcGxvZyddKSB7XG4gICAgc2VsZi5fb3Bsb2dIYW5kbGUgPSBuZXcgT3Bsb2dIYW5kbGUob3B0aW9ucy5vcGxvZ1VybCwgc2VsZi5kYi5kYXRhYmFzZU5hbWUpO1xuICAgIHNlbGYuX2RvY0ZldGNoZXIgPSBuZXcgRG9jRmV0Y2hlcihzZWxmKTtcbiAgfVxufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5jbG9zZSA9IGZ1bmN0aW9uKCkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKCEgc2VsZi5kYilcbiAgICB0aHJvdyBFcnJvcihcImNsb3NlIGNhbGxlZCBiZWZvcmUgQ29ubmVjdGlvbiBjcmVhdGVkP1wiKTtcblxuICAvLyBYWFggcHJvYmFibHkgdW50ZXN0ZWRcbiAgdmFyIG9wbG9nSGFuZGxlID0gc2VsZi5fb3Bsb2dIYW5kbGU7XG4gIHNlbGYuX29wbG9nSGFuZGxlID0gbnVsbDtcbiAgaWYgKG9wbG9nSGFuZGxlKVxuICAgIG9wbG9nSGFuZGxlLnN0b3AoKTtcblxuICAvLyBVc2UgRnV0dXJlLndyYXAgc28gdGhhdCBlcnJvcnMgZ2V0IHRocm93bi4gVGhpcyBoYXBwZW5zIHRvXG4gIC8vIHdvcmsgZXZlbiBvdXRzaWRlIGEgZmliZXIgc2luY2UgdGhlICdjbG9zZScgbWV0aG9kIGlzIG5vdFxuICAvLyBhY3R1YWxseSBhc3luY2hyb25vdXMuXG4gIEZ1dHVyZS53cmFwKF8uYmluZChzZWxmLmRiLmNsb3NlLCBzZWxmLmRiKSkodHJ1ZSkud2FpdCgpO1xufTtcblxuLy8gUmV0dXJucyB0aGUgTW9uZ28gQ29sbGVjdGlvbiBvYmplY3Q7IG1heSB5aWVsZC5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUucmF3Q29sbGVjdGlvbiA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSkge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKCEgc2VsZi5kYilcbiAgICB0aHJvdyBFcnJvcihcInJhd0NvbGxlY3Rpb24gY2FsbGVkIGJlZm9yZSBDb25uZWN0aW9uIGNyZWF0ZWQ/XCIpO1xuXG4gIHZhciBmdXR1cmUgPSBuZXcgRnV0dXJlO1xuICBzZWxmLmRiLmNvbGxlY3Rpb24oY29sbGVjdGlvbk5hbWUsIGZ1dHVyZS5yZXNvbHZlcigpKTtcbiAgcmV0dXJuIGZ1dHVyZS53YWl0KCk7XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9jcmVhdGVDYXBwZWRDb2xsZWN0aW9uID0gZnVuY3Rpb24gKFxuICAgIGNvbGxlY3Rpb25OYW1lLCBieXRlU2l6ZSwgbWF4RG9jdW1lbnRzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBpZiAoISBzZWxmLmRiKVxuICAgIHRocm93IEVycm9yKFwiX2NyZWF0ZUNhcHBlZENvbGxlY3Rpb24gY2FsbGVkIGJlZm9yZSBDb25uZWN0aW9uIGNyZWF0ZWQ/XCIpO1xuXG4gIHZhciBmdXR1cmUgPSBuZXcgRnV0dXJlKCk7XG4gIHNlbGYuZGIuY3JlYXRlQ29sbGVjdGlvbihcbiAgICBjb2xsZWN0aW9uTmFtZSxcbiAgICB7IGNhcHBlZDogdHJ1ZSwgc2l6ZTogYnl0ZVNpemUsIG1heDogbWF4RG9jdW1lbnRzIH0sXG4gICAgZnV0dXJlLnJlc29sdmVyKCkpO1xuICBmdXR1cmUud2FpdCgpO1xufTtcblxuLy8gVGhpcyBzaG91bGQgYmUgY2FsbGVkIHN5bmNocm9ub3VzbHkgd2l0aCBhIHdyaXRlLCB0byBjcmVhdGUgYVxuLy8gdHJhbnNhY3Rpb24gb24gdGhlIGN1cnJlbnQgd3JpdGUgZmVuY2UsIGlmIGFueS4gQWZ0ZXIgd2UgY2FuIHJlYWRcbi8vIHRoZSB3cml0ZSwgYW5kIGFmdGVyIG9ic2VydmVycyBoYXZlIGJlZW4gbm90aWZpZWQgKG9yIGF0IGxlYXN0LFxuLy8gYWZ0ZXIgdGhlIG9ic2VydmVyIG5vdGlmaWVycyBoYXZlIGFkZGVkIHRoZW1zZWx2ZXMgdG8gdGhlIHdyaXRlXG4vLyBmZW5jZSksIHlvdSBzaG91bGQgY2FsbCAnY29tbWl0dGVkKCknIG9uIHRoZSBvYmplY3QgcmV0dXJuZWQuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9tYXliZUJlZ2luV3JpdGUgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBmZW5jZSA9IEREUFNlcnZlci5fQ3VycmVudFdyaXRlRmVuY2UuZ2V0KCk7XG4gIGlmIChmZW5jZSkge1xuICAgIHJldHVybiBmZW5jZS5iZWdpbldyaXRlKCk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIHtjb21taXR0ZWQ6IGZ1bmN0aW9uICgpIHt9fTtcbiAgfVxufTtcblxuLy8gSW50ZXJuYWwgaW50ZXJmYWNlOiBhZGRzIGEgY2FsbGJhY2sgd2hpY2ggaXMgY2FsbGVkIHdoZW4gdGhlIE1vbmdvIHByaW1hcnlcbi8vIGNoYW5nZXMuIFJldHVybnMgYSBzdG9wIGhhbmRsZS5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX29uRmFpbG92ZXIgPSBmdW5jdGlvbiAoY2FsbGJhY2spIHtcbiAgcmV0dXJuIHRoaXMuX29uRmFpbG92ZXJIb29rLnJlZ2lzdGVyKGNhbGxiYWNrKTtcbn07XG5cblxuLy8vLy8vLy8vLy8vIFB1YmxpYyBBUEkgLy8vLy8vLy8vL1xuXG4vLyBUaGUgd3JpdGUgbWV0aG9kcyBibG9jayB1bnRpbCB0aGUgZGF0YWJhc2UgaGFzIGNvbmZpcm1lZCB0aGUgd3JpdGUgKGl0IG1heVxuLy8gbm90IGJlIHJlcGxpY2F0ZWQgb3Igc3RhYmxlIG9uIGRpc2ssIGJ1dCBvbmUgc2VydmVyIGhhcyBjb25maXJtZWQgaXQpIGlmIG5vXG4vLyBjYWxsYmFjayBpcyBwcm92aWRlZC4gSWYgYSBjYWxsYmFjayBpcyBwcm92aWRlZCwgdGhlbiB0aGV5IGNhbGwgdGhlIGNhbGxiYWNrXG4vLyB3aGVuIHRoZSB3cml0ZSBpcyBjb25maXJtZWQuIFRoZXkgcmV0dXJuIG5vdGhpbmcgb24gc3VjY2VzcywgYW5kIHJhaXNlIGFuXG4vLyBleGNlcHRpb24gb24gZmFpbHVyZS5cbi8vXG4vLyBBZnRlciBtYWtpbmcgYSB3cml0ZSAod2l0aCBpbnNlcnQsIHVwZGF0ZSwgcmVtb3ZlKSwgb2JzZXJ2ZXJzIGFyZVxuLy8gbm90aWZpZWQgYXN5bmNocm9ub3VzbHkuIElmIHlvdSB3YW50IHRvIHJlY2VpdmUgYSBjYWxsYmFjayBvbmNlIGFsbFxuLy8gb2YgdGhlIG9ic2VydmVyIG5vdGlmaWNhdGlvbnMgaGF2ZSBsYW5kZWQgZm9yIHlvdXIgd3JpdGUsIGRvIHRoZVxuLy8gd3JpdGVzIGluc2lkZSBhIHdyaXRlIGZlbmNlIChzZXQgRERQU2VydmVyLl9DdXJyZW50V3JpdGVGZW5jZSB0byBhIG5ld1xuLy8gX1dyaXRlRmVuY2UsIGFuZCB0aGVuIHNldCBhIGNhbGxiYWNrIG9uIHRoZSB3cml0ZSBmZW5jZS4pXG4vL1xuLy8gU2luY2Ugb3VyIGV4ZWN1dGlvbiBlbnZpcm9ubWVudCBpcyBzaW5nbGUtdGhyZWFkZWQsIHRoaXMgaXNcbi8vIHdlbGwtZGVmaW5lZCAtLSBhIHdyaXRlIFwiaGFzIGJlZW4gbWFkZVwiIGlmIGl0J3MgcmV0dXJuZWQsIGFuZCBhblxuLy8gb2JzZXJ2ZXIgXCJoYXMgYmVlbiBub3RpZmllZFwiIGlmIGl0cyBjYWxsYmFjayBoYXMgcmV0dXJuZWQuXG5cbnZhciB3cml0ZUNhbGxiYWNrID0gZnVuY3Rpb24gKHdyaXRlLCByZWZyZXNoLCBjYWxsYmFjaykge1xuICByZXR1cm4gZnVuY3Rpb24gKGVyciwgcmVzdWx0KSB7XG4gICAgaWYgKCEgZXJyKSB7XG4gICAgICAvLyBYWFggV2UgZG9uJ3QgaGF2ZSB0byBydW4gdGhpcyBvbiBlcnJvciwgcmlnaHQ/XG4gICAgICB0cnkge1xuICAgICAgICByZWZyZXNoKCk7XG4gICAgICB9IGNhdGNoIChyZWZyZXNoRXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIGNhbGxiYWNrKHJlZnJlc2hFcnIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyByZWZyZXNoRXJyO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgY2FsbGJhY2soZXJyLCByZXN1bHQpO1xuICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9O1xufTtcblxudmFyIGJpbmRFbnZpcm9ubWVudEZvcldyaXRlID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gIHJldHVybiBNZXRlb3IuYmluZEVudmlyb25tZW50KGNhbGxiYWNrLCBcIk1vbmdvIHdyaXRlXCIpO1xufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5faW5zZXJ0ID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25fbmFtZSwgZG9jdW1lbnQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2spIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIHZhciBzZW5kRXJyb3IgPSBmdW5jdGlvbiAoZSkge1xuICAgIGlmIChjYWxsYmFjaylcbiAgICAgIHJldHVybiBjYWxsYmFjayhlKTtcbiAgICB0aHJvdyBlO1xuICB9O1xuXG4gIGlmIChjb2xsZWN0aW9uX25hbWUgPT09IFwiX19fbWV0ZW9yX2ZhaWx1cmVfdGVzdF9jb2xsZWN0aW9uXCIpIHtcbiAgICB2YXIgZSA9IG5ldyBFcnJvcihcIkZhaWx1cmUgdGVzdFwiKTtcbiAgICBlLl9leHBlY3RlZEJ5VGVzdCA9IHRydWU7XG4gICAgc2VuZEVycm9yKGUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghKExvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChkb2N1bWVudCkgJiZcbiAgICAgICAgIUVKU09OLl9pc0N1c3RvbVR5cGUoZG9jdW1lbnQpKSkge1xuICAgIHNlbmRFcnJvcihuZXcgRXJyb3IoXG4gICAgICBcIk9ubHkgcGxhaW4gb2JqZWN0cyBtYXkgYmUgaW5zZXJ0ZWQgaW50byBNb25nb0RCXCIpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB2YXIgd3JpdGUgPSBzZWxmLl9tYXliZUJlZ2luV3JpdGUoKTtcbiAgdmFyIHJlZnJlc2ggPSBmdW5jdGlvbiAoKSB7XG4gICAgTWV0ZW9yLnJlZnJlc2goe2NvbGxlY3Rpb246IGNvbGxlY3Rpb25fbmFtZSwgaWQ6IGRvY3VtZW50Ll9pZCB9KTtcbiAgfTtcbiAgY2FsbGJhY2sgPSBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZSh3cml0ZUNhbGxiYWNrKHdyaXRlLCByZWZyZXNoLCBjYWxsYmFjaykpO1xuICB0cnkge1xuICAgIHZhciBjb2xsZWN0aW9uID0gc2VsZi5yYXdDb2xsZWN0aW9uKGNvbGxlY3Rpb25fbmFtZSk7XG4gICAgY29sbGVjdGlvbi5pbnNlcnQocmVwbGFjZVR5cGVzKGRvY3VtZW50LCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgICAgICAgICAgICAgICAgICAge3NhZmU6IHRydWV9LCBjYWxsYmFjayk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHdyaXRlLmNvbW1pdHRlZCgpO1xuICAgIHRocm93IGVycjtcbiAgfVxufTtcblxuLy8gQ2F1c2UgcXVlcmllcyB0aGF0IG1heSBiZSBhZmZlY3RlZCBieSB0aGUgc2VsZWN0b3IgdG8gcG9sbCBpbiB0aGlzIHdyaXRlXG4vLyBmZW5jZS5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX3JlZnJlc2ggPSBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUsIHNlbGVjdG9yKSB7XG4gIHZhciByZWZyZXNoS2V5ID0ge2NvbGxlY3Rpb246IGNvbGxlY3Rpb25OYW1lfTtcbiAgLy8gSWYgd2Uga25vdyB3aGljaCBkb2N1bWVudHMgd2UncmUgcmVtb3ZpbmcsIGRvbid0IHBvbGwgcXVlcmllcyB0aGF0IGFyZVxuICAvLyBzcGVjaWZpYyB0byBvdGhlciBkb2N1bWVudHMuIChOb3RlIHRoYXQgbXVsdGlwbGUgbm90aWZpY2F0aW9ucyBoZXJlIHNob3VsZFxuICAvLyBub3QgY2F1c2UgbXVsdGlwbGUgcG9sbHMsIHNpbmNlIGFsbCBvdXIgbGlzdGVuZXIgaXMgZG9pbmcgaXMgZW5xdWV1ZWluZyBhXG4gIC8vIHBvbGwuKVxuICB2YXIgc3BlY2lmaWNJZHMgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgaWYgKHNwZWNpZmljSWRzKSB7XG4gICAgXy5lYWNoKHNwZWNpZmljSWRzLCBmdW5jdGlvbiAoaWQpIHtcbiAgICAgIE1ldGVvci5yZWZyZXNoKF8uZXh0ZW5kKHtpZDogaWR9LCByZWZyZXNoS2V5KSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgTWV0ZW9yLnJlZnJlc2gocmVmcmVzaEtleSk7XG4gIH1cbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX3JlbW92ZSA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uX25hbWUsIHNlbGVjdG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBpZiAoY29sbGVjdGlvbl9uYW1lID09PSBcIl9fX21ldGVvcl9mYWlsdXJlX3Rlc3RfY29sbGVjdGlvblwiKSB7XG4gICAgdmFyIGUgPSBuZXcgRXJyb3IoXCJGYWlsdXJlIHRlc3RcIik7XG4gICAgZS5fZXhwZWN0ZWRCeVRlc3QgPSB0cnVlO1xuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgcmV0dXJuIGNhbGxiYWNrKGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfVxuXG4gIHZhciB3cml0ZSA9IHNlbGYuX21heWJlQmVnaW5Xcml0ZSgpO1xuICB2YXIgcmVmcmVzaCA9IGZ1bmN0aW9uICgpIHtcbiAgICBzZWxmLl9yZWZyZXNoKGNvbGxlY3Rpb25fbmFtZSwgc2VsZWN0b3IpO1xuICB9O1xuICBjYWxsYmFjayA9IGJpbmRFbnZpcm9ubWVudEZvcldyaXRlKHdyaXRlQ2FsbGJhY2sod3JpdGUsIHJlZnJlc2gsIGNhbGxiYWNrKSk7XG5cbiAgdHJ5IHtcbiAgICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uX25hbWUpO1xuICAgIHZhciB3cmFwcGVkQ2FsbGJhY2sgPSBmdW5jdGlvbihlcnIsIGRyaXZlclJlc3VsdCkge1xuICAgICAgY2FsbGJhY2soZXJyLCB0cmFuc2Zvcm1SZXN1bHQoZHJpdmVyUmVzdWx0KS5udW1iZXJBZmZlY3RlZCk7XG4gICAgfTtcbiAgICBjb2xsZWN0aW9uLnJlbW92ZShyZXBsYWNlVHlwZXMoc2VsZWN0b3IsIHJlcGxhY2VNZXRlb3JBdG9tV2l0aE1vbmdvKSxcbiAgICAgICAgICAgICAgICAgICAgICAge3NhZmU6IHRydWV9LCB3cmFwcGVkQ2FsbGJhY2spO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX2Ryb3BDb2xsZWN0aW9uID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBjYikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgdmFyIHdyaXRlID0gc2VsZi5fbWF5YmVCZWdpbldyaXRlKCk7XG4gIHZhciByZWZyZXNoID0gZnVuY3Rpb24gKCkge1xuICAgIE1ldGVvci5yZWZyZXNoKHtjb2xsZWN0aW9uOiBjb2xsZWN0aW9uTmFtZSwgaWQ6IG51bGwsXG4gICAgICAgICAgICAgICAgICAgIGRyb3BDb2xsZWN0aW9uOiB0cnVlfSk7XG4gIH07XG4gIGNiID0gYmluZEVudmlyb25tZW50Rm9yV3JpdGUod3JpdGVDYWxsYmFjayh3cml0ZSwgcmVmcmVzaCwgY2IpKTtcblxuICB0cnkge1xuICAgIHZhciBjb2xsZWN0aW9uID0gc2VsZi5yYXdDb2xsZWN0aW9uKGNvbGxlY3Rpb25OYW1lKTtcbiAgICBjb2xsZWN0aW9uLmRyb3AoY2IpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgdGhyb3cgZTtcbiAgfVxufTtcblxuLy8gRm9yIHRlc3Rpbmcgb25seS4gIFNsaWdodGx5IGJldHRlciB0aGFuIGBjLnJhd0RhdGFiYXNlKCkuZHJvcERhdGFiYXNlKClgXG4vLyBiZWNhdXNlIGl0IGxldHMgdGhlIHRlc3QncyBmZW5jZSB3YWl0IGZvciBpdCB0byBiZSBjb21wbGV0ZS5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX2Ryb3BEYXRhYmFzZSA9IGZ1bmN0aW9uIChjYikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgdmFyIHdyaXRlID0gc2VsZi5fbWF5YmVCZWdpbldyaXRlKCk7XG4gIHZhciByZWZyZXNoID0gZnVuY3Rpb24gKCkge1xuICAgIE1ldGVvci5yZWZyZXNoKHsgZHJvcERhdGFiYXNlOiB0cnVlIH0pO1xuICB9O1xuICBjYiA9IGJpbmRFbnZpcm9ubWVudEZvcldyaXRlKHdyaXRlQ2FsbGJhY2sod3JpdGUsIHJlZnJlc2gsIGNiKSk7XG5cbiAgdHJ5IHtcbiAgICBzZWxmLmRiLmRyb3BEYXRhYmFzZShjYik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB3cml0ZS5jb21taXR0ZWQoKTtcbiAgICB0aHJvdyBlO1xuICB9XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl91cGRhdGUgPSBmdW5jdGlvbiAoY29sbGVjdGlvbl9uYW1lLCBzZWxlY3RvciwgbW9kLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBpZiAoISBjYWxsYmFjayAmJiBvcHRpb25zIGluc3RhbmNlb2YgRnVuY3Rpb24pIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IG51bGw7XG4gIH1cblxuICBpZiAoY29sbGVjdGlvbl9uYW1lID09PSBcIl9fX21ldGVvcl9mYWlsdXJlX3Rlc3RfY29sbGVjdGlvblwiKSB7XG4gICAgdmFyIGUgPSBuZXcgRXJyb3IoXCJGYWlsdXJlIHRlc3RcIik7XG4gICAgZS5fZXhwZWN0ZWRCeVRlc3QgPSB0cnVlO1xuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgcmV0dXJuIGNhbGxiYWNrKGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfVxuXG4gIC8vIGV4cGxpY2l0IHNhZmV0eSBjaGVjay4gbnVsbCBhbmQgdW5kZWZpbmVkIGNhbiBjcmFzaCB0aGUgbW9uZ29cbiAgLy8gZHJpdmVyLiBBbHRob3VnaCB0aGUgbm9kZSBkcml2ZXIgYW5kIG1pbmltb25nbyBkbyAnc3VwcG9ydCdcbiAgLy8gbm9uLW9iamVjdCBtb2RpZmllciBpbiB0aGF0IHRoZXkgZG9uJ3QgY3Jhc2gsIHRoZXkgYXJlIG5vdFxuICAvLyBtZWFuaW5nZnVsIG9wZXJhdGlvbnMgYW5kIGRvIG5vdCBkbyBhbnl0aGluZy4gRGVmZW5zaXZlbHkgdGhyb3cgYW5cbiAgLy8gZXJyb3IgaGVyZS5cbiAgaWYgKCFtb2QgfHwgdHlwZW9mIG1vZCAhPT0gJ29iamVjdCcpXG4gICAgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCBtb2RpZmllci4gTW9kaWZpZXIgbXVzdCBiZSBhbiBvYmplY3QuXCIpO1xuXG4gIGlmICghKExvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChtb2QpICYmXG4gICAgICAgICFFSlNPTi5faXNDdXN0b21UeXBlKG1vZCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJPbmx5IHBsYWluIG9iamVjdHMgbWF5IGJlIHVzZWQgYXMgcmVwbGFjZW1lbnRcIiArXG4gICAgICAgIFwiIGRvY3VtZW50cyBpbiBNb25nb0RCXCIpO1xuICB9XG5cbiAgaWYgKCFvcHRpb25zKSBvcHRpb25zID0ge307XG5cbiAgdmFyIHdyaXRlID0gc2VsZi5fbWF5YmVCZWdpbldyaXRlKCk7XG4gIHZhciByZWZyZXNoID0gZnVuY3Rpb24gKCkge1xuICAgIHNlbGYuX3JlZnJlc2goY29sbGVjdGlvbl9uYW1lLCBzZWxlY3Rvcik7XG4gIH07XG4gIGNhbGxiYWNrID0gd3JpdGVDYWxsYmFjayh3cml0ZSwgcmVmcmVzaCwgY2FsbGJhY2spO1xuICB0cnkge1xuICAgIHZhciBjb2xsZWN0aW9uID0gc2VsZi5yYXdDb2xsZWN0aW9uKGNvbGxlY3Rpb25fbmFtZSk7XG4gICAgdmFyIG1vbmdvT3B0cyA9IHtzYWZlOiB0cnVlfTtcbiAgICAvLyBleHBsaWN0bHkgZW51bWVyYXRlIG9wdGlvbnMgdGhhdCBtaW5pbW9uZ28gc3VwcG9ydHNcbiAgICBpZiAob3B0aW9ucy51cHNlcnQpIG1vbmdvT3B0cy51cHNlcnQgPSB0cnVlO1xuICAgIGlmIChvcHRpb25zLm11bHRpKSBtb25nb09wdHMubXVsdGkgPSB0cnVlO1xuICAgIC8vIExldHMgeW91IGdldCBhIG1vcmUgbW9yZSBmdWxsIHJlc3VsdCBmcm9tIE1vbmdvREIuIFVzZSB3aXRoIGNhdXRpb246XG4gICAgLy8gbWlnaHQgbm90IHdvcmsgd2l0aCBDLnVwc2VydCAoYXMgb3Bwb3NlZCB0byBDLnVwZGF0ZSh7dXBzZXJ0OnRydWV9KSBvclxuICAgIC8vIHdpdGggc2ltdWxhdGVkIHVwc2VydC5cbiAgICBpZiAob3B0aW9ucy5mdWxsUmVzdWx0KSBtb25nb09wdHMuZnVsbFJlc3VsdCA9IHRydWU7XG5cbiAgICB2YXIgbW9uZ29TZWxlY3RvciA9IHJlcGxhY2VUeXBlcyhzZWxlY3RvciwgcmVwbGFjZU1ldGVvckF0b21XaXRoTW9uZ28pO1xuICAgIHZhciBtb25nb01vZCA9IHJlcGxhY2VUeXBlcyhtb2QsIHJlcGxhY2VNZXRlb3JBdG9tV2l0aE1vbmdvKTtcblxuICAgIHZhciBpc01vZGlmeSA9IExvY2FsQ29sbGVjdGlvbi5faXNNb2RpZmljYXRpb25Nb2QobW9uZ29Nb2QpO1xuXG4gICAgaWYgKG9wdGlvbnMuX2ZvcmJpZFJlcGxhY2UgJiYgIWlzTW9kaWZ5KSB7XG4gICAgICB2YXIgZXJyID0gbmV3IEVycm9yKFwiSW52YWxpZCBtb2RpZmllci4gUmVwbGFjZW1lbnRzIGFyZSBmb3JiaWRkZW4uXCIpO1xuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFdlJ3ZlIGFscmVhZHkgcnVuIHJlcGxhY2VUeXBlcy9yZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyBvblxuICAgIC8vIHNlbGVjdG9yIGFuZCBtb2QuICBXZSBhc3N1bWUgaXQgZG9lc24ndCBtYXR0ZXIsIGFzIGZhciBhc1xuICAgIC8vIHRoZSBiZWhhdmlvciBvZiBtb2RpZmllcnMgaXMgY29uY2VybmVkLCB3aGV0aGVyIGBfbW9kaWZ5YFxuICAgIC8vIGlzIHJ1biBvbiBFSlNPTiBvciBvbiBtb25nby1jb252ZXJ0ZWQgRUpTT04uXG5cbiAgICAvLyBSdW4gdGhpcyBjb2RlIHVwIGZyb250IHNvIHRoYXQgaXQgZmFpbHMgZmFzdCBpZiBzb21lb25lIHVzZXNcbiAgICAvLyBhIE1vbmdvIHVwZGF0ZSBvcGVyYXRvciB3ZSBkb24ndCBzdXBwb3J0LlxuICAgIGxldCBrbm93bklkO1xuICAgIGlmIChvcHRpb25zLnVwc2VydCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgbGV0IG5ld0RvYyA9IExvY2FsQ29sbGVjdGlvbi5fY3JlYXRlVXBzZXJ0RG9jdW1lbnQoc2VsZWN0b3IsIG1vZCk7XG4gICAgICAgIGtub3duSWQgPSBuZXdEb2MuX2lkO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICAgIHJldHVybiBjYWxsYmFjayhlcnIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChvcHRpb25zLnVwc2VydCAmJlxuICAgICAgICAhIGlzTW9kaWZ5ICYmXG4gICAgICAgICEga25vd25JZCAmJlxuICAgICAgICBvcHRpb25zLmluc2VydGVkSWQgJiZcbiAgICAgICAgISAob3B0aW9ucy5pbnNlcnRlZElkIGluc3RhbmNlb2YgTW9uZ28uT2JqZWN0SUQgJiZcbiAgICAgICAgICAgb3B0aW9ucy5nZW5lcmF0ZWRJZCkpIHtcbiAgICAgIC8vIEluIGNhc2Ugb2YgYW4gdXBzZXJ0IHdpdGggYSByZXBsYWNlbWVudCwgd2hlcmUgdGhlcmUgaXMgbm8gX2lkIGRlZmluZWRcbiAgICAgIC8vIGluIGVpdGhlciB0aGUgcXVlcnkgb3IgdGhlIHJlcGxhY2VtZW50IGRvYywgbW9uZ28gd2lsbCBnZW5lcmF0ZSBhbiBpZCBpdHNlbGYuXG4gICAgICAvLyBUaGVyZWZvcmUgd2UgbmVlZCB0aGlzIHNwZWNpYWwgc3RyYXRlZ3kgaWYgd2Ugd2FudCB0byBjb250cm9sIHRoZSBpZCBvdXJzZWx2ZXMuXG5cbiAgICAgIC8vIFdlIGRvbid0IG5lZWQgdG8gZG8gdGhpcyB3aGVuOlxuICAgICAgLy8gLSBUaGlzIGlzIG5vdCBhIHJlcGxhY2VtZW50LCBzbyB3ZSBjYW4gYWRkIGFuIF9pZCB0byAkc2V0T25JbnNlcnRcbiAgICAgIC8vIC0gVGhlIGlkIGlzIGRlZmluZWQgYnkgcXVlcnkgb3IgbW9kIHdlIGNhbiBqdXN0IGFkZCBpdCB0byB0aGUgcmVwbGFjZW1lbnQgZG9jXG4gICAgICAvLyAtIFRoZSB1c2VyIGRpZCBub3Qgc3BlY2lmeSBhbnkgaWQgcHJlZmVyZW5jZSBhbmQgdGhlIGlkIGlzIGEgTW9uZ28gT2JqZWN0SWQsXG4gICAgICAvLyAgICAgdGhlbiB3ZSBjYW4ganVzdCBsZXQgTW9uZ28gZ2VuZXJhdGUgdGhlIGlkXG5cbiAgICAgIHNpbXVsYXRlVXBzZXJ0V2l0aEluc2VydGVkSWQoXG4gICAgICAgIGNvbGxlY3Rpb24sIG1vbmdvU2VsZWN0b3IsIG1vbmdvTW9kLCBvcHRpb25zLFxuICAgICAgICAvLyBUaGlzIGNhbGxiYWNrIGRvZXMgbm90IG5lZWQgdG8gYmUgYmluZEVudmlyb25tZW50J2VkIGJlY2F1c2VcbiAgICAgICAgLy8gc2ltdWxhdGVVcHNlcnRXaXRoSW5zZXJ0ZWRJZCgpIHdyYXBzIGl0IGFuZCB0aGVuIHBhc3NlcyBpdCB0aHJvdWdoXG4gICAgICAgIC8vIGJpbmRFbnZpcm9ubWVudEZvcldyaXRlLlxuICAgICAgICBmdW5jdGlvbiAoZXJyb3IsIHJlc3VsdCkge1xuICAgICAgICAgIC8vIElmIHdlIGdvdCBoZXJlIHZpYSBhIHVwc2VydCgpIGNhbGwsIHRoZW4gb3B0aW9ucy5fcmV0dXJuT2JqZWN0IHdpbGxcbiAgICAgICAgICAvLyBiZSBzZXQgYW5kIHdlIHNob3VsZCByZXR1cm4gdGhlIHdob2xlIG9iamVjdC4gT3RoZXJ3aXNlLCB3ZSBzaG91bGRcbiAgICAgICAgICAvLyBqdXN0IHJldHVybiB0aGUgbnVtYmVyIG9mIGFmZmVjdGVkIGRvY3MgdG8gbWF0Y2ggdGhlIG1vbmdvIEFQSS5cbiAgICAgICAgICBpZiAocmVzdWx0ICYmICEgb3B0aW9ucy5fcmV0dXJuT2JqZWN0KSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnJvciwgcmVzdWx0Lm51bWJlckFmZmVjdGVkKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY2FsbGJhY2soZXJyb3IsIHJlc3VsdCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICApO1xuICAgIH0gZWxzZSB7XG5cbiAgICAgIGlmIChvcHRpb25zLnVwc2VydCAmJiAha25vd25JZCAmJiBvcHRpb25zLmluc2VydGVkSWQgJiYgaXNNb2RpZnkpIHtcbiAgICAgICAgaWYgKCFtb25nb01vZC5oYXNPd25Qcm9wZXJ0eSgnJHNldE9uSW5zZXJ0JykpIHtcbiAgICAgICAgICBtb25nb01vZC4kc2V0T25JbnNlcnQgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBrbm93bklkID0gb3B0aW9ucy5pbnNlcnRlZElkO1xuICAgICAgICBPYmplY3QuYXNzaWduKG1vbmdvTW9kLiRzZXRPbkluc2VydCwgcmVwbGFjZVR5cGVzKHtfaWQ6IG9wdGlvbnMuaW5zZXJ0ZWRJZH0sIHJlcGxhY2VNZXRlb3JBdG9tV2l0aE1vbmdvKSk7XG4gICAgICB9XG5cbiAgICAgIGNvbGxlY3Rpb24udXBkYXRlKFxuICAgICAgICBtb25nb1NlbGVjdG9yLCBtb25nb01vZCwgbW9uZ29PcHRzLFxuICAgICAgICBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZShmdW5jdGlvbiAoZXJyLCByZXN1bHQpIHtcbiAgICAgICAgICBpZiAoISBlcnIpIHtcbiAgICAgICAgICAgIHZhciBtZXRlb3JSZXN1bHQgPSB0cmFuc2Zvcm1SZXN1bHQocmVzdWx0KTtcbiAgICAgICAgICAgIGlmIChtZXRlb3JSZXN1bHQgJiYgb3B0aW9ucy5fcmV0dXJuT2JqZWN0KSB7XG4gICAgICAgICAgICAgIC8vIElmIHRoaXMgd2FzIGFuIHVwc2VydCgpIGNhbGwsIGFuZCB3ZSBlbmRlZCB1cFxuICAgICAgICAgICAgICAvLyBpbnNlcnRpbmcgYSBuZXcgZG9jIGFuZCB3ZSBrbm93IGl0cyBpZCwgdGhlblxuICAgICAgICAgICAgICAvLyByZXR1cm4gdGhhdCBpZCBhcyB3ZWxsLlxuICAgICAgICAgICAgICBpZiAob3B0aW9ucy51cHNlcnQgJiYgbWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQpIHtcbiAgICAgICAgICAgICAgICBpZiAoa25vd25JZCkge1xuICAgICAgICAgICAgICAgICAgbWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQgPSBrbm93bklkO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQgaW5zdGFuY2VvZiBNb25nb0RCLk9iamVjdElEKSB7XG4gICAgICAgICAgICAgICAgICBtZXRlb3JSZXN1bHQuaW5zZXJ0ZWRJZCA9IG5ldyBNb25nby5PYmplY3RJRChtZXRlb3JSZXN1bHQuaW5zZXJ0ZWRJZC50b0hleFN0cmluZygpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICBjYWxsYmFjayhlcnIsIG1ldGVvclJlc3VsdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBjYWxsYmFjayhlcnIsIG1ldGVvclJlc3VsdC5udW1iZXJBZmZlY3RlZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgdGhyb3cgZTtcbiAgfVxufTtcblxudmFyIHRyYW5zZm9ybVJlc3VsdCA9IGZ1bmN0aW9uIChkcml2ZXJSZXN1bHQpIHtcbiAgdmFyIG1ldGVvclJlc3VsdCA9IHsgbnVtYmVyQWZmZWN0ZWQ6IDAgfTtcbiAgaWYgKGRyaXZlclJlc3VsdCkge1xuICAgIHZhciBtb25nb1Jlc3VsdCA9IGRyaXZlclJlc3VsdC5yZXN1bHQ7XG5cbiAgICAvLyBPbiB1cGRhdGVzIHdpdGggdXBzZXJ0OnRydWUsIHRoZSBpbnNlcnRlZCB2YWx1ZXMgY29tZSBhcyBhIGxpc3Qgb2ZcbiAgICAvLyB1cHNlcnRlZCB2YWx1ZXMgLS0gZXZlbiB3aXRoIG9wdGlvbnMubXVsdGksIHdoZW4gdGhlIHVwc2VydCBkb2VzIGluc2VydCxcbiAgICAvLyBpdCBvbmx5IGluc2VydHMgb25lIGVsZW1lbnQuXG4gICAgaWYgKG1vbmdvUmVzdWx0LnVwc2VydGVkKSB7XG4gICAgICBtZXRlb3JSZXN1bHQubnVtYmVyQWZmZWN0ZWQgKz0gbW9uZ29SZXN1bHQudXBzZXJ0ZWQubGVuZ3RoO1xuXG4gICAgICBpZiAobW9uZ29SZXN1bHQudXBzZXJ0ZWQubGVuZ3RoID09IDEpIHtcbiAgICAgICAgbWV0ZW9yUmVzdWx0Lmluc2VydGVkSWQgPSBtb25nb1Jlc3VsdC51cHNlcnRlZFswXS5faWQ7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIG1ldGVvclJlc3VsdC5udW1iZXJBZmZlY3RlZCA9IG1vbmdvUmVzdWx0Lm47XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG1ldGVvclJlc3VsdDtcbn07XG5cblxudmFyIE5VTV9PUFRJTUlTVElDX1RSSUVTID0gMztcblxuLy8gZXhwb3NlZCBmb3IgdGVzdGluZ1xuTW9uZ29Db25uZWN0aW9uLl9pc0Nhbm5vdENoYW5nZUlkRXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG5cbiAgLy8gTW9uZ28gMy4yLiogcmV0dXJucyBlcnJvciBhcyBuZXh0IE9iamVjdDpcbiAgLy8ge25hbWU6IFN0cmluZywgY29kZTogTnVtYmVyLCBlcnJtc2c6IFN0cmluZ31cbiAgLy8gT2xkZXIgTW9uZ28gcmV0dXJuczpcbiAgLy8ge25hbWU6IFN0cmluZywgY29kZTogTnVtYmVyLCBlcnI6IFN0cmluZ31cbiAgdmFyIGVycm9yID0gZXJyLmVycm1zZyB8fCBlcnIuZXJyO1xuXG4gIC8vIFdlIGRvbid0IHVzZSB0aGUgZXJyb3IgY29kZSBoZXJlXG4gIC8vIGJlY2F1c2UgdGhlIGVycm9yIGNvZGUgd2Ugb2JzZXJ2ZWQgaXQgcHJvZHVjaW5nICgxNjgzNykgYXBwZWFycyB0byBiZVxuICAvLyBhIGZhciBtb3JlIGdlbmVyaWMgZXJyb3IgY29kZSBiYXNlZCBvbiBleGFtaW5pbmcgdGhlIHNvdXJjZS5cbiAgaWYgKGVycm9yLmluZGV4T2YoJ1RoZSBfaWQgZmllbGQgY2Fubm90IGJlIGNoYW5nZWQnKSA9PT0gMFxuICAgIHx8IGVycm9yLmluZGV4T2YoXCJ0aGUgKGltbXV0YWJsZSkgZmllbGQgJ19pZCcgd2FzIGZvdW5kIHRvIGhhdmUgYmVlbiBhbHRlcmVkIHRvIF9pZFwiKSAhPT0gLTEpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn07XG5cbnZhciBzaW11bGF0ZVVwc2VydFdpdGhJbnNlcnRlZElkID0gZnVuY3Rpb24gKGNvbGxlY3Rpb24sIHNlbGVjdG9yLCBtb2QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLCBjYWxsYmFjaykge1xuICAvLyBTVFJBVEVHWTogRmlyc3QgdHJ5IGRvaW5nIGFuIHVwc2VydCB3aXRoIGEgZ2VuZXJhdGVkIElELlxuICAvLyBJZiB0aGlzIHRocm93cyBhbiBlcnJvciBhYm91dCBjaGFuZ2luZyB0aGUgSUQgb24gYW4gZXhpc3RpbmcgZG9jdW1lbnRcbiAgLy8gdGhlbiB3aXRob3V0IGFmZmVjdGluZyB0aGUgZGF0YWJhc2UsIHdlIGtub3cgd2Ugc2hvdWxkIHByb2JhYmx5IHRyeVxuICAvLyBhbiB1cGRhdGUgd2l0aG91dCB0aGUgZ2VuZXJhdGVkIElELiBJZiBpdCBhZmZlY3RlZCAwIGRvY3VtZW50cyxcbiAgLy8gdGhlbiB3aXRob3V0IGFmZmVjdGluZyB0aGUgZGF0YWJhc2UsIHdlIHRoZSBkb2N1bWVudCB0aGF0IGZpcnN0XG4gIC8vIGdhdmUgdGhlIGVycm9yIGlzIHByb2JhYmx5IHJlbW92ZWQgYW5kIHdlIG5lZWQgdG8gdHJ5IGFuIGluc2VydCBhZ2FpblxuICAvLyBXZSBnbyBiYWNrIHRvIHN0ZXAgb25lIGFuZCByZXBlYXQuXG4gIC8vIExpa2UgYWxsIFwib3B0aW1pc3RpYyB3cml0ZVwiIHNjaGVtZXMsIHdlIHJlbHkgb24gdGhlIGZhY3QgdGhhdCBpdCdzXG4gIC8vIHVubGlrZWx5IG91ciB3cml0ZXMgd2lsbCBjb250aW51ZSB0byBiZSBpbnRlcmZlcmVkIHdpdGggdW5kZXIgbm9ybWFsXG4gIC8vIGNpcmN1bXN0YW5jZXMgKHRob3VnaCBzdWZmaWNpZW50bHkgaGVhdnkgY29udGVudGlvbiB3aXRoIHdyaXRlcnNcbiAgLy8gZGlzYWdyZWVpbmcgb24gdGhlIGV4aXN0ZW5jZSBvZiBhbiBvYmplY3Qgd2lsbCBjYXVzZSB3cml0ZXMgdG8gZmFpbFxuICAvLyBpbiB0aGVvcnkpLlxuXG4gIHZhciBpbnNlcnRlZElkID0gb3B0aW9ucy5pbnNlcnRlZElkOyAvLyBtdXN0IGV4aXN0XG4gIHZhciBtb25nb09wdHNGb3JVcGRhdGUgPSB7XG4gICAgc2FmZTogdHJ1ZSxcbiAgICBtdWx0aTogb3B0aW9ucy5tdWx0aVxuICB9O1xuICB2YXIgbW9uZ29PcHRzRm9ySW5zZXJ0ID0ge1xuICAgIHNhZmU6IHRydWUsXG4gICAgdXBzZXJ0OiB0cnVlXG4gIH07XG5cbiAgdmFyIHJlcGxhY2VtZW50V2l0aElkID0gT2JqZWN0LmFzc2lnbihcbiAgICByZXBsYWNlVHlwZXMoe19pZDogaW5zZXJ0ZWRJZH0sIHJlcGxhY2VNZXRlb3JBdG9tV2l0aE1vbmdvKSxcbiAgICBtb2QpO1xuXG4gIHZhciB0cmllcyA9IE5VTV9PUFRJTUlTVElDX1RSSUVTO1xuXG4gIHZhciBkb1VwZGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgICB0cmllcy0tO1xuICAgIGlmICghIHRyaWVzKSB7XG4gICAgICBjYWxsYmFjayhuZXcgRXJyb3IoXCJVcHNlcnQgZmFpbGVkIGFmdGVyIFwiICsgTlVNX09QVElNSVNUSUNfVFJJRVMgKyBcIiB0cmllcy5cIikpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb2xsZWN0aW9uLnVwZGF0ZShzZWxlY3RvciwgbW9kLCBtb25nb09wdHNGb3JVcGRhdGUsXG4gICAgICAgICAgICAgICAgICAgICAgICBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZShmdW5jdGlvbiAoZXJyLCByZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVzdWx0ICYmIHJlc3VsdC5yZXN1bHQubiAhPSAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbnVtYmVyQWZmZWN0ZWQ6IHJlc3VsdC5yZXN1bHQublxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRvQ29uZGl0aW9uYWxJbnNlcnQoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICAgIH1cbiAgfTtcblxuICB2YXIgZG9Db25kaXRpb25hbEluc2VydCA9IGZ1bmN0aW9uICgpIHtcbiAgICBjb2xsZWN0aW9uLnVwZGF0ZShzZWxlY3RvciwgcmVwbGFjZW1lbnRXaXRoSWQsIG1vbmdvT3B0c0Zvckluc2VydCxcbiAgICAgICAgICAgICAgICAgICAgICBiaW5kRW52aXJvbm1lbnRGb3JXcml0ZShmdW5jdGlvbiAoZXJyLCByZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gZmlndXJlIG91dCBpZiB0aGlzIGlzIGFcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gXCJjYW5ub3QgY2hhbmdlIF9pZCBvZiBkb2N1bWVudFwiIGVycm9yLCBhbmRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgc28sIHRyeSBkb1VwZGF0ZSgpIGFnYWluLCB1cCB0byAzIHRpbWVzLlxuICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoTW9uZ29Db25uZWN0aW9uLl9pc0Nhbm5vdENoYW5nZUlkRXJyb3IoZXJyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRvVXBkYXRlKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2sobnVsbCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bWJlckFmZmVjdGVkOiByZXN1bHQucmVzdWx0LnVwc2VydGVkLmxlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbnNlcnRlZElkOiBpbnNlcnRlZElkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gIH07XG5cbiAgZG9VcGRhdGUoKTtcbn07XG5cbl8uZWFjaChbXCJpbnNlcnRcIiwgXCJ1cGRhdGVcIiwgXCJyZW1vdmVcIiwgXCJkcm9wQ29sbGVjdGlvblwiLCBcImRyb3BEYXRhYmFzZVwiXSwgZnVuY3Rpb24gKG1ldGhvZCkge1xuICBNb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlW21ldGhvZF0gPSBmdW5jdGlvbiAoLyogYXJndW1lbnRzICovKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBNZXRlb3Iud3JhcEFzeW5jKHNlbGZbXCJfXCIgKyBtZXRob2RdKS5hcHBseShzZWxmLCBhcmd1bWVudHMpO1xuICB9O1xufSk7XG5cbi8vIFhYWCBNb25nb0Nvbm5lY3Rpb24udXBzZXJ0KCkgZG9lcyBub3QgcmV0dXJuIHRoZSBpZCBvZiB0aGUgaW5zZXJ0ZWQgZG9jdW1lbnRcbi8vIHVubGVzcyB5b3Ugc2V0IGl0IGV4cGxpY2l0bHkgaW4gdGhlIHNlbGVjdG9yIG9yIG1vZGlmaWVyIChhcyBhIHJlcGxhY2VtZW50XG4vLyBkb2MpLlxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS51cHNlcnQgPSBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUsIHNlbGVjdG9yLCBtb2QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zLCBjYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIGlmICh0eXBlb2Ygb3B0aW9ucyA9PT0gXCJmdW5jdGlvblwiICYmICEgY2FsbGJhY2spIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgcmV0dXJuIHNlbGYudXBkYXRlKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3RvciwgbW9kLFxuICAgICAgICAgICAgICAgICAgICAgXy5leHRlbmQoe30sIG9wdGlvbnMsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgdXBzZXJ0OiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICAgICBfcmV0dXJuT2JqZWN0OiB0cnVlXG4gICAgICAgICAgICAgICAgICAgICB9KSwgY2FsbGJhY2spO1xufTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5maW5kID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3Rvciwgb3B0aW9ucykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEpXG4gICAgc2VsZWN0b3IgPSB7fTtcblxuICByZXR1cm4gbmV3IEN1cnNvcihcbiAgICBzZWxmLCBuZXcgQ3Vyc29yRGVzY3JpcHRpb24oY29sbGVjdGlvbk5hbWUsIHNlbGVjdG9yLCBvcHRpb25zKSk7XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLmZpbmRPbmUgPSBmdW5jdGlvbiAoY29sbGVjdGlvbl9uYW1lLCBzZWxlY3RvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEpXG4gICAgc2VsZWN0b3IgPSB7fTtcblxuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgb3B0aW9ucy5saW1pdCA9IDE7XG4gIHJldHVybiBzZWxmLmZpbmQoY29sbGVjdGlvbl9uYW1lLCBzZWxlY3Rvciwgb3B0aW9ucykuZmV0Y2goKVswXTtcbn07XG5cbi8vIFdlJ2xsIGFjdHVhbGx5IGRlc2lnbiBhbiBpbmRleCBBUEkgbGF0ZXIuIEZvciBub3csIHdlIGp1c3QgcGFzcyB0aHJvdWdoIHRvXG4vLyBNb25nbydzLCBidXQgbWFrZSBpdCBzeW5jaHJvbm91cy5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX2Vuc3VyZUluZGV4ID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBpbmRleCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIC8vIFdlIGV4cGVjdCB0aGlzIGZ1bmN0aW9uIHRvIGJlIGNhbGxlZCBhdCBzdGFydHVwLCBub3QgZnJvbSB3aXRoaW4gYSBtZXRob2QsXG4gIC8vIHNvIHdlIGRvbid0IGludGVyYWN0IHdpdGggdGhlIHdyaXRlIGZlbmNlLlxuICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjb2xsZWN0aW9uTmFtZSk7XG4gIHZhciBmdXR1cmUgPSBuZXcgRnV0dXJlO1xuICB2YXIgaW5kZXhOYW1lID0gY29sbGVjdGlvbi5lbnN1cmVJbmRleChpbmRleCwgb3B0aW9ucywgZnV0dXJlLnJlc29sdmVyKCkpO1xuICBmdXR1cmUud2FpdCgpO1xufTtcbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX2Ryb3BJbmRleCA9IGZ1bmN0aW9uIChjb2xsZWN0aW9uTmFtZSwgaW5kZXgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgb25seSB1c2VkIGJ5IHRlc3QgY29kZSwgbm90IHdpdGhpbiBhIG1ldGhvZCwgc28gd2UgZG9uJ3RcbiAgLy8gaW50ZXJhY3Qgd2l0aCB0aGUgd3JpdGUgZmVuY2UuXG4gIHZhciBjb2xsZWN0aW9uID0gc2VsZi5yYXdDb2xsZWN0aW9uKGNvbGxlY3Rpb25OYW1lKTtcbiAgdmFyIGZ1dHVyZSA9IG5ldyBGdXR1cmU7XG4gIHZhciBpbmRleE5hbWUgPSBjb2xsZWN0aW9uLmRyb3BJbmRleChpbmRleCwgZnV0dXJlLnJlc29sdmVyKCkpO1xuICBmdXR1cmUud2FpdCgpO1xufTtcblxuLy8gQ1VSU09SU1xuXG4vLyBUaGVyZSBhcmUgc2V2ZXJhbCBjbGFzc2VzIHdoaWNoIHJlbGF0ZSB0byBjdXJzb3JzOlxuLy9cbi8vIEN1cnNvckRlc2NyaXB0aW9uIHJlcHJlc2VudHMgdGhlIGFyZ3VtZW50cyB1c2VkIHRvIGNvbnN0cnVjdCBhIGN1cnNvcjpcbi8vIGNvbGxlY3Rpb25OYW1lLCBzZWxlY3RvciwgYW5kIChmaW5kKSBvcHRpb25zLiAgQmVjYXVzZSBpdCBpcyB1c2VkIGFzIGEga2V5XG4vLyBmb3IgY3Vyc29yIGRlLWR1cCwgZXZlcnl0aGluZyBpbiBpdCBzaG91bGQgZWl0aGVyIGJlIEpTT04tc3RyaW5naWZpYWJsZSBvclxuLy8gbm90IGFmZmVjdCBvYnNlcnZlQ2hhbmdlcyBvdXRwdXQgKGVnLCBvcHRpb25zLnRyYW5zZm9ybSBmdW5jdGlvbnMgYXJlIG5vdFxuLy8gc3RyaW5naWZpYWJsZSBidXQgZG8gbm90IGFmZmVjdCBvYnNlcnZlQ2hhbmdlcykuXG4vL1xuLy8gU3luY2hyb25vdXNDdXJzb3IgaXMgYSB3cmFwcGVyIGFyb3VuZCBhIE1vbmdvREIgY3Vyc29yXG4vLyB3aGljaCBpbmNsdWRlcyBmdWxseS1zeW5jaHJvbm91cyB2ZXJzaW9ucyBvZiBmb3JFYWNoLCBldGMuXG4vL1xuLy8gQ3Vyc29yIGlzIHRoZSBjdXJzb3Igb2JqZWN0IHJldHVybmVkIGZyb20gZmluZCgpLCB3aGljaCBpbXBsZW1lbnRzIHRoZVxuLy8gZG9jdW1lbnRlZCBNb25nby5Db2xsZWN0aW9uIGN1cnNvciBBUEkuICBJdCB3cmFwcyBhIEN1cnNvckRlc2NyaXB0aW9uIGFuZCBhXG4vLyBTeW5jaHJvbm91c0N1cnNvciAobGF6aWx5OiBpdCBkb2Vzbid0IGNvbnRhY3QgTW9uZ28gdW50aWwgeW91IGNhbGwgYSBtZXRob2Rcbi8vIGxpa2UgZmV0Y2ggb3IgZm9yRWFjaCBvbiBpdCkuXG4vL1xuLy8gT2JzZXJ2ZUhhbmRsZSBpcyB0aGUgXCJvYnNlcnZlIGhhbmRsZVwiIHJldHVybmVkIGZyb20gb2JzZXJ2ZUNoYW5nZXMuIEl0IGhhcyBhXG4vLyByZWZlcmVuY2UgdG8gYW4gT2JzZXJ2ZU11bHRpcGxleGVyLlxuLy9cbi8vIE9ic2VydmVNdWx0aXBsZXhlciBhbGxvd3MgbXVsdGlwbGUgaWRlbnRpY2FsIE9ic2VydmVIYW5kbGVzIHRvIGJlIGRyaXZlbiBieSBhXG4vLyBzaW5nbGUgb2JzZXJ2ZSBkcml2ZXIuXG4vL1xuLy8gVGhlcmUgYXJlIHR3byBcIm9ic2VydmUgZHJpdmVyc1wiIHdoaWNoIGRyaXZlIE9ic2VydmVNdWx0aXBsZXhlcnM6XG4vLyAgIC0gUG9sbGluZ09ic2VydmVEcml2ZXIgY2FjaGVzIHRoZSByZXN1bHRzIG9mIGEgcXVlcnkgYW5kIHJlcnVucyBpdCB3aGVuXG4vLyAgICAgbmVjZXNzYXJ5LlxuLy8gICAtIE9wbG9nT2JzZXJ2ZURyaXZlciBmb2xsb3dzIHRoZSBNb25nbyBvcGVyYXRpb24gbG9nIHRvIGRpcmVjdGx5IG9ic2VydmVcbi8vICAgICBkYXRhYmFzZSBjaGFuZ2VzLlxuLy8gQm90aCBpbXBsZW1lbnRhdGlvbnMgZm9sbG93IHRoZSBzYW1lIHNpbXBsZSBpbnRlcmZhY2U6IHdoZW4geW91IGNyZWF0ZSB0aGVtLFxuLy8gdGhleSBzdGFydCBzZW5kaW5nIG9ic2VydmVDaGFuZ2VzIGNhbGxiYWNrcyAoYW5kIGEgcmVhZHkoKSBpbnZvY2F0aW9uKSB0b1xuLy8gdGhlaXIgT2JzZXJ2ZU11bHRpcGxleGVyLCBhbmQgeW91IHN0b3AgdGhlbSBieSBjYWxsaW5nIHRoZWlyIHN0b3AoKSBtZXRob2QuXG5cbkN1cnNvckRlc2NyaXB0aW9uID0gZnVuY3Rpb24gKGNvbGxlY3Rpb25OYW1lLCBzZWxlY3Rvciwgb3B0aW9ucykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYuY29sbGVjdGlvbk5hbWUgPSBjb2xsZWN0aW9uTmFtZTtcbiAgc2VsZi5zZWxlY3RvciA9IE1vbmdvLkNvbGxlY3Rpb24uX3Jld3JpdGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gIHNlbGYub3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG59O1xuXG5DdXJzb3IgPSBmdW5jdGlvbiAobW9uZ28sIGN1cnNvckRlc2NyaXB0aW9uKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBzZWxmLl9tb25nbyA9IG1vbmdvO1xuICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiA9IGN1cnNvckRlc2NyaXB0aW9uO1xuICBzZWxmLl9zeW5jaHJvbm91c0N1cnNvciA9IG51bGw7XG59O1xuXG5fLmVhY2goWydmb3JFYWNoJywgJ21hcCcsICdmZXRjaCcsICdjb3VudCddLCBmdW5jdGlvbiAobWV0aG9kKSB7XG4gIEN1cnNvci5wcm90b3R5cGVbbWV0aG9kXSA9IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBZb3UgY2FuIG9ubHkgb2JzZXJ2ZSBhIHRhaWxhYmxlIGN1cnNvci5cbiAgICBpZiAoc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50YWlsYWJsZSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBjYWxsIFwiICsgbWV0aG9kICsgXCIgb24gYSB0YWlsYWJsZSBjdXJzb3JcIik7XG5cbiAgICBpZiAoIXNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yKSB7XG4gICAgICBzZWxmLl9zeW5jaHJvbm91c0N1cnNvciA9IHNlbGYuX21vbmdvLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihcbiAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIHtcbiAgICAgICAgICAvLyBNYWtlIHN1cmUgdGhhdCB0aGUgXCJzZWxmXCIgYXJndW1lbnQgdG8gZm9yRWFjaC9tYXAgY2FsbGJhY2tzIGlzIHRoZVxuICAgICAgICAgIC8vIEN1cnNvciwgbm90IHRoZSBTeW5jaHJvbm91c0N1cnNvci5cbiAgICAgICAgICBzZWxmRm9ySXRlcmF0aW9uOiBzZWxmLFxuICAgICAgICAgIHVzZVRyYW5zZm9ybTogdHJ1ZVxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gc2VsZi5fc3luY2hyb25vdXNDdXJzb3JbbWV0aG9kXS5hcHBseShcbiAgICAgIHNlbGYuX3N5bmNocm9ub3VzQ3Vyc29yLCBhcmd1bWVudHMpO1xuICB9O1xufSk7XG5cbi8vIFNpbmNlIHdlIGRvbid0IGFjdHVhbGx5IGhhdmUgYSBcIm5leHRPYmplY3RcIiBpbnRlcmZhY2UsIHRoZXJlJ3MgcmVhbGx5IG5vXG4vLyByZWFzb24gdG8gaGF2ZSBhIFwicmV3aW5kXCIgaW50ZXJmYWNlLiAgQWxsIGl0IGRpZCB3YXMgbWFrZSBtdWx0aXBsZSBjYWxsc1xuLy8gdG8gZmV0Y2gvbWFwL2ZvckVhY2ggcmV0dXJuIG5vdGhpbmcgdGhlIHNlY29uZCB0aW1lLlxuLy8gWFhYIENPTVBBVCBXSVRIIDAuOC4xXG5DdXJzb3IucHJvdG90eXBlLnJld2luZCA9IGZ1bmN0aW9uICgpIHtcbn07XG5cbkN1cnNvci5wcm90b3R5cGUuZ2V0VHJhbnNmb3JtID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50cmFuc2Zvcm07XG59O1xuXG4vLyBXaGVuIHlvdSBjYWxsIE1ldGVvci5wdWJsaXNoKCkgd2l0aCBhIGZ1bmN0aW9uIHRoYXQgcmV0dXJucyBhIEN1cnNvciwgd2UgbmVlZFxuLy8gdG8gdHJhbnNtdXRlIGl0IGludG8gdGhlIGVxdWl2YWxlbnQgc3Vic2NyaXB0aW9uLiAgVGhpcyBpcyB0aGUgZnVuY3Rpb24gdGhhdFxuLy8gZG9lcyB0aGF0LlxuXG5DdXJzb3IucHJvdG90eXBlLl9wdWJsaXNoQ3Vyc29yID0gZnVuY3Rpb24gKHN1Yikge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHZhciBjb2xsZWN0aW9uID0gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWU7XG4gIHJldHVybiBNb25nby5Db2xsZWN0aW9uLl9wdWJsaXNoQ3Vyc29yKHNlbGYsIHN1YiwgY29sbGVjdGlvbik7XG59O1xuXG4vLyBVc2VkIHRvIGd1YXJhbnRlZSB0aGF0IHB1Ymxpc2ggZnVuY3Rpb25zIHJldHVybiBhdCBtb3N0IG9uZSBjdXJzb3IgcGVyXG4vLyBjb2xsZWN0aW9uLiBQcml2YXRlLCBiZWNhdXNlIHdlIG1pZ2h0IGxhdGVyIGhhdmUgY3Vyc29ycyB0aGF0IGluY2x1ZGVcbi8vIGRvY3VtZW50cyBmcm9tIG11bHRpcGxlIGNvbGxlY3Rpb25zIHNvbWVob3cuXG5DdXJzb3IucHJvdG90eXBlLl9nZXRDb2xsZWN0aW9uTmFtZSA9IGZ1bmN0aW9uICgpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICByZXR1cm4gc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWU7XG59O1xuXG5DdXJzb3IucHJvdG90eXBlLm9ic2VydmUgPSBmdW5jdGlvbiAoY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyhzZWxmLCBjYWxsYmFja3MpO1xufTtcblxuQ3Vyc29yLnByb3RvdHlwZS5vYnNlcnZlQ2hhbmdlcyA9IGZ1bmN0aW9uIChjYWxsYmFja3MpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICB2YXIgbWV0aG9kcyA9IFtcbiAgICAnYWRkZWRBdCcsXG4gICAgJ2FkZGVkJyxcbiAgICAnY2hhbmdlZEF0JyxcbiAgICAnY2hhbmdlZCcsXG4gICAgJ3JlbW92ZWRBdCcsXG4gICAgJ3JlbW92ZWQnLFxuICAgICdtb3ZlZFRvJ1xuICBdO1xuICB2YXIgb3JkZXJlZCA9IExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkKGNhbGxiYWNrcyk7XG5cbiAgLy8gWFhYOiBDYW4gd2UgZmluZCBvdXQgaWYgY2FsbGJhY2tzIGFyZSBmcm9tIG9ic2VydmU/XG4gIHZhciBleGNlcHRpb25OYW1lID0gJyBvYnNlcnZlL29ic2VydmVDaGFuZ2VzIGNhbGxiYWNrJztcbiAgbWV0aG9kcy5mb3JFYWNoKGZ1bmN0aW9uIChtZXRob2QpIHtcbiAgICBpZiAoY2FsbGJhY2tzW21ldGhvZF0gJiYgdHlwZW9mIGNhbGxiYWNrc1ttZXRob2RdID09IFwiZnVuY3Rpb25cIikge1xuICAgICAgY2FsbGJhY2tzW21ldGhvZF0gPSBNZXRlb3IuYmluZEVudmlyb25tZW50KGNhbGxiYWNrc1ttZXRob2RdLCBtZXRob2QgKyBleGNlcHRpb25OYW1lKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiBzZWxmLl9tb25nby5fb2JzZXJ2ZUNoYW5nZXMoXG4gICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIG9yZGVyZWQsIGNhbGxiYWNrcyk7XG59O1xuXG5Nb25nb0Nvbm5lY3Rpb24ucHJvdG90eXBlLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvciA9IGZ1bmN0aW9uKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IF8ucGljayhvcHRpb25zIHx8IHt9LCAnc2VsZkZvckl0ZXJhdGlvbicsICd1c2VUcmFuc2Zvcm0nKTtcblxuICB2YXIgY29sbGVjdGlvbiA9IHNlbGYucmF3Q29sbGVjdGlvbihjdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSk7XG4gIHZhciBjdXJzb3JPcHRpb25zID0gY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucztcbiAgdmFyIG1vbmdvT3B0aW9ucyA9IHtcbiAgICBzb3J0OiBjdXJzb3JPcHRpb25zLnNvcnQsXG4gICAgbGltaXQ6IGN1cnNvck9wdGlvbnMubGltaXQsXG4gICAgc2tpcDogY3Vyc29yT3B0aW9ucy5za2lwXG4gIH07XG5cbiAgLy8gRG8gd2Ugd2FudCBhIHRhaWxhYmxlIGN1cnNvciAod2hpY2ggb25seSB3b3JrcyBvbiBjYXBwZWQgY29sbGVjdGlvbnMpP1xuICBpZiAoY3Vyc29yT3B0aW9ucy50YWlsYWJsZSkge1xuICAgIC8vIFdlIHdhbnQgYSB0YWlsYWJsZSBjdXJzb3IuLi5cbiAgICBtb25nb09wdGlvbnMudGFpbGFibGUgPSB0cnVlO1xuICAgIC8vIC4uLiBhbmQgZm9yIHRoZSBzZXJ2ZXIgdG8gd2FpdCBhIGJpdCBpZiBhbnkgZ2V0TW9yZSBoYXMgbm8gZGF0YSAocmF0aGVyXG4gICAgLy8gdGhhbiBtYWtpbmcgdXMgcHV0IHRoZSByZWxldmFudCBzbGVlcHMgaW4gdGhlIGNsaWVudCkuLi5cbiAgICBtb25nb09wdGlvbnMuYXdhaXRkYXRhID0gdHJ1ZTtcbiAgICAvLyAuLi4gYW5kIHRvIGtlZXAgcXVlcnlpbmcgdGhlIHNlcnZlciBpbmRlZmluaXRlbHkgcmF0aGVyIHRoYW4ganVzdCA1IHRpbWVzXG4gICAgLy8gaWYgdGhlcmUncyBubyBtb3JlIGRhdGEuXG4gICAgbW9uZ29PcHRpb25zLm51bWJlck9mUmV0cmllcyA9IC0xO1xuICAgIC8vIEFuZCBpZiB0aGlzIGlzIG9uIHRoZSBvcGxvZyBjb2xsZWN0aW9uIGFuZCB0aGUgY3Vyc29yIHNwZWNpZmllcyBhICd0cycsXG4gICAgLy8gdGhlbiBzZXQgdGhlIHVuZG9jdW1lbnRlZCBvcGxvZyByZXBsYXkgZmxhZywgd2hpY2ggZG9lcyBhIHNwZWNpYWwgc2NhbiB0b1xuICAgIC8vIGZpbmQgdGhlIGZpcnN0IGRvY3VtZW50IChpbnN0ZWFkIG9mIGNyZWF0aW5nIGFuIGluZGV4IG9uIHRzKS4gVGhpcyBpcyBhXG4gICAgLy8gdmVyeSBoYXJkLWNvZGVkIE1vbmdvIGZsYWcgd2hpY2ggb25seSB3b3JrcyBvbiB0aGUgb3Bsb2cgY29sbGVjdGlvbiBhbmRcbiAgICAvLyBvbmx5IHdvcmtzIHdpdGggdGhlIHRzIGZpZWxkLlxuICAgIGlmIChjdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSA9PT0gT1BMT0dfQ09MTEVDVElPTiAmJlxuICAgICAgICBjdXJzb3JEZXNjcmlwdGlvbi5zZWxlY3Rvci50cykge1xuICAgICAgbW9uZ29PcHRpb25zLm9wbG9nUmVwbGF5ID0gdHJ1ZTtcbiAgICB9XG4gIH1cblxuICB2YXIgZGJDdXJzb3IgPSBjb2xsZWN0aW9uLmZpbmQoXG4gICAgcmVwbGFjZVR5cGVzKGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yLCByZXBsYWNlTWV0ZW9yQXRvbVdpdGhNb25nbyksXG4gICAgY3Vyc29yT3B0aW9ucy5maWVsZHMsIG1vbmdvT3B0aW9ucyk7XG5cbiAgaWYgKHR5cGVvZiBjdXJzb3JPcHRpb25zLm1heFRpbWVNcyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICBkYkN1cnNvciA9IGRiQ3Vyc29yLm1heFRpbWVNUyhjdXJzb3JPcHRpb25zLm1heFRpbWVNcyk7XG4gIH1cbiAgaWYgKHR5cGVvZiBjdXJzb3JPcHRpb25zLmhpbnQgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgZGJDdXJzb3IgPSBkYkN1cnNvci5oaW50KGN1cnNvck9wdGlvbnMuaGludCk7XG4gIH1cblxuICByZXR1cm4gbmV3IFN5bmNocm9ub3VzQ3Vyc29yKGRiQ3Vyc29yLCBjdXJzb3JEZXNjcmlwdGlvbiwgb3B0aW9ucyk7XG59O1xuXG52YXIgU3luY2hyb25vdXNDdXJzb3IgPSBmdW5jdGlvbiAoZGJDdXJzb3IsIGN1cnNvckRlc2NyaXB0aW9uLCBvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgb3B0aW9ucyA9IF8ucGljayhvcHRpb25zIHx8IHt9LCAnc2VsZkZvckl0ZXJhdGlvbicsICd1c2VUcmFuc2Zvcm0nKTtcblxuICBzZWxmLl9kYkN1cnNvciA9IGRiQ3Vyc29yO1xuICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiA9IGN1cnNvckRlc2NyaXB0aW9uO1xuICAvLyBUaGUgXCJzZWxmXCIgYXJndW1lbnQgcGFzc2VkIHRvIGZvckVhY2gvbWFwIGNhbGxiYWNrcy4gSWYgd2UncmUgd3JhcHBlZFxuICAvLyBpbnNpZGUgYSB1c2VyLXZpc2libGUgQ3Vyc29yLCB3ZSB3YW50IHRvIHByb3ZpZGUgdGhlIG91dGVyIGN1cnNvciFcbiAgc2VsZi5fc2VsZkZvckl0ZXJhdGlvbiA9IG9wdGlvbnMuc2VsZkZvckl0ZXJhdGlvbiB8fCBzZWxmO1xuICBpZiAob3B0aW9ucy51c2VUcmFuc2Zvcm0gJiYgY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50cmFuc2Zvcm0pIHtcbiAgICBzZWxmLl90cmFuc2Zvcm0gPSBMb2NhbENvbGxlY3Rpb24ud3JhcFRyYW5zZm9ybShcbiAgICAgIGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMudHJhbnNmb3JtKTtcbiAgfSBlbHNlIHtcbiAgICBzZWxmLl90cmFuc2Zvcm0gPSBudWxsO1xuICB9XG5cbiAgLy8gTmVlZCB0byBzcGVjaWZ5IHRoYXQgdGhlIGNhbGxiYWNrIGlzIHRoZSBmaXJzdCBhcmd1bWVudCB0byBuZXh0T2JqZWN0LFxuICAvLyBzaW5jZSBvdGhlcndpc2Ugd2hlbiB3ZSB0cnkgdG8gY2FsbCBpdCB3aXRoIG5vIGFyZ3MgdGhlIGRyaXZlciB3aWxsXG4gIC8vIGludGVycHJldCBcInVuZGVmaW5lZFwiIGZpcnN0IGFyZyBhcyBhbiBvcHRpb25zIGhhc2ggYW5kIGNyYXNoLlxuICBzZWxmLl9zeW5jaHJvbm91c05leHRPYmplY3QgPSBGdXR1cmUud3JhcChcbiAgICBkYkN1cnNvci5uZXh0T2JqZWN0LmJpbmQoZGJDdXJzb3IpLCAwKTtcbiAgc2VsZi5fc3luY2hyb25vdXNDb3VudCA9IEZ1dHVyZS53cmFwKGRiQ3Vyc29yLmNvdW50LmJpbmQoZGJDdXJzb3IpKTtcbiAgc2VsZi5fdmlzaXRlZElkcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xufTtcblxuXy5leHRlbmQoU3luY2hyb25vdXNDdXJzb3IucHJvdG90eXBlLCB7XG4gIF9uZXh0T2JqZWN0OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciBkb2MgPSBzZWxmLl9zeW5jaHJvbm91c05leHRPYmplY3QoKS53YWl0KCk7XG5cbiAgICAgIGlmICghZG9jKSByZXR1cm4gbnVsbDtcbiAgICAgIGRvYyA9IHJlcGxhY2VUeXBlcyhkb2MsIHJlcGxhY2VNb25nb0F0b21XaXRoTWV0ZW9yKTtcblxuICAgICAgaWYgKCFzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnRhaWxhYmxlICYmIF8uaGFzKGRvYywgJ19pZCcpKSB7XG4gICAgICAgIC8vIERpZCBNb25nbyBnaXZlIHVzIGR1cGxpY2F0ZSBkb2N1bWVudHMgaW4gdGhlIHNhbWUgY3Vyc29yPyBJZiBzbyxcbiAgICAgICAgLy8gaWdub3JlIHRoaXMgb25lLiAoRG8gdGhpcyBiZWZvcmUgdGhlIHRyYW5zZm9ybSwgc2luY2UgdHJhbnNmb3JtIG1pZ2h0XG4gICAgICAgIC8vIHJldHVybiBzb21lIHVucmVsYXRlZCB2YWx1ZS4pIFdlIGRvbid0IGRvIHRoaXMgZm9yIHRhaWxhYmxlIGN1cnNvcnMsXG4gICAgICAgIC8vIGJlY2F1c2Ugd2Ugd2FudCB0byBtYWludGFpbiBPKDEpIG1lbW9yeSB1c2FnZS4gQW5kIGlmIHRoZXJlIGlzbid0IF9pZFxuICAgICAgICAvLyBmb3Igc29tZSByZWFzb24gKG1heWJlIGl0J3MgdGhlIG9wbG9nKSwgdGhlbiB3ZSBkb24ndCBkbyB0aGlzIGVpdGhlci5cbiAgICAgICAgLy8gKEJlIGNhcmVmdWwgdG8gZG8gdGhpcyBmb3IgZmFsc2V5IGJ1dCBleGlzdGluZyBfaWQsIHRob3VnaC4pXG4gICAgICAgIGlmIChzZWxmLl92aXNpdGVkSWRzLmhhcyhkb2MuX2lkKSkgY29udGludWU7XG4gICAgICAgIHNlbGYuX3Zpc2l0ZWRJZHMuc2V0KGRvYy5faWQsIHRydWUpO1xuICAgICAgfVxuXG4gICAgICBpZiAoc2VsZi5fdHJhbnNmb3JtKVxuICAgICAgICBkb2MgPSBzZWxmLl90cmFuc2Zvcm0oZG9jKTtcblxuICAgICAgcmV0dXJuIGRvYztcbiAgICB9XG4gIH0sXG5cbiAgZm9yRWFjaDogZnVuY3Rpb24gKGNhbGxiYWNrLCB0aGlzQXJnKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgLy8gR2V0IGJhY2sgdG8gdGhlIGJlZ2lubmluZy5cbiAgICBzZWxmLl9yZXdpbmQoKTtcblxuICAgIC8vIFdlIGltcGxlbWVudCB0aGUgbG9vcCBvdXJzZWxmIGluc3RlYWQgb2YgdXNpbmcgc2VsZi5fZGJDdXJzb3IuZWFjaCxcbiAgICAvLyBiZWNhdXNlIFwiZWFjaFwiIHdpbGwgY2FsbCBpdHMgY2FsbGJhY2sgb3V0c2lkZSBvZiBhIGZpYmVyIHdoaWNoIG1ha2VzIGl0XG4gICAgLy8gbXVjaCBtb3JlIGNvbXBsZXggdG8gbWFrZSB0aGlzIGZ1bmN0aW9uIHN5bmNocm9ub3VzLlxuICAgIHZhciBpbmRleCA9IDA7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIHZhciBkb2MgPSBzZWxmLl9uZXh0T2JqZWN0KCk7XG4gICAgICBpZiAoIWRvYykgcmV0dXJuO1xuICAgICAgY2FsbGJhY2suY2FsbCh0aGlzQXJnLCBkb2MsIGluZGV4KyssIHNlbGYuX3NlbGZGb3JJdGVyYXRpb24pO1xuICAgIH1cbiAgfSxcblxuICAvLyBYWFggQWxsb3cgb3ZlcmxhcHBpbmcgY2FsbGJhY2sgZXhlY3V0aW9ucyBpZiBjYWxsYmFjayB5aWVsZHMuXG4gIG1hcDogZnVuY3Rpb24gKGNhbGxiYWNrLCB0aGlzQXJnKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHZhciByZXMgPSBbXTtcbiAgICBzZWxmLmZvckVhY2goZnVuY3Rpb24gKGRvYywgaW5kZXgpIHtcbiAgICAgIHJlcy5wdXNoKGNhbGxiYWNrLmNhbGwodGhpc0FyZywgZG9jLCBpbmRleCwgc2VsZi5fc2VsZkZvckl0ZXJhdGlvbikpO1xuICAgIH0pO1xuICAgIHJldHVybiByZXM7XG4gIH0sXG5cbiAgX3Jld2luZDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcblxuICAgIC8vIGtub3duIHRvIGJlIHN5bmNocm9ub3VzXG4gICAgc2VsZi5fZGJDdXJzb3IucmV3aW5kKCk7XG5cbiAgICBzZWxmLl92aXNpdGVkSWRzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gIH0sXG5cbiAgLy8gTW9zdGx5IHVzYWJsZSBmb3IgdGFpbGFibGUgY3Vyc29ycy5cbiAgY2xvc2U6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICBzZWxmLl9kYkN1cnNvci5jbG9zZSgpO1xuICB9LFxuXG4gIGZldGNoOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBzZWxmLm1hcChfLmlkZW50aXR5KTtcbiAgfSxcblxuICBjb3VudDogZnVuY3Rpb24gKGFwcGx5U2tpcExpbWl0ID0gZmFsc2UpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgcmV0dXJuIHNlbGYuX3N5bmNocm9ub3VzQ291bnQoYXBwbHlTa2lwTGltaXQpLndhaXQoKTtcbiAgfSxcblxuICAvLyBUaGlzIG1ldGhvZCBpcyBOT1Qgd3JhcHBlZCBpbiBDdXJzb3IuXG4gIGdldFJhd09iamVjdHM6IGZ1bmN0aW9uIChvcmRlcmVkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICByZXR1cm4gc2VsZi5mZXRjaCgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YXIgcmVzdWx0cyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgc2VsZi5mb3JFYWNoKGZ1bmN0aW9uIChkb2MpIHtcbiAgICAgICAgcmVzdWx0cy5zZXQoZG9jLl9pZCwgZG9jKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuICB9XG59KTtcblxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS50YWlsID0gZnVuY3Rpb24gKGN1cnNvckRlc2NyaXB0aW9uLCBkb2NDYWxsYmFjaykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIGlmICghY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy50YWlsYWJsZSlcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSB0YWlsIGEgdGFpbGFibGUgY3Vyc29yXCIpO1xuXG4gIHZhciBjdXJzb3IgPSBzZWxmLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihjdXJzb3JEZXNjcmlwdGlvbik7XG5cbiAgdmFyIHN0b3BwZWQgPSBmYWxzZTtcbiAgdmFyIGxhc3RUUztcbiAgdmFyIGxvb3AgPSBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGRvYyA9IG51bGw7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGlmIChzdG9wcGVkKVxuICAgICAgICByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBkb2MgPSBjdXJzb3IuX25leHRPYmplY3QoKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvLyBUaGVyZSdzIG5vIGdvb2Qgd2F5IHRvIGZpZ3VyZSBvdXQgaWYgdGhpcyB3YXMgYWN0dWFsbHkgYW4gZXJyb3JcbiAgICAgICAgLy8gZnJvbSBNb25nby4gQWggd2VsbC4gQnV0IGVpdGhlciB3YXksIHdlIG5lZWQgdG8gcmV0cnkgdGhlIGN1cnNvclxuICAgICAgICAvLyAodW5sZXNzIHRoZSBmYWlsdXJlIHdhcyBiZWNhdXNlIHRoZSBvYnNlcnZlIGdvdCBzdG9wcGVkKS5cbiAgICAgICAgZG9jID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIC8vIFNpbmNlIGN1cnNvci5fbmV4dE9iamVjdCBjYW4geWllbGQsIHdlIG5lZWQgdG8gY2hlY2sgYWdhaW4gdG8gc2VlIGlmXG4gICAgICAvLyB3ZSd2ZSBiZWVuIHN0b3BwZWQgYmVmb3JlIGNhbGxpbmcgdGhlIGNhbGxiYWNrLlxuICAgICAgaWYgKHN0b3BwZWQpXG4gICAgICAgIHJldHVybjtcbiAgICAgIGlmIChkb2MpIHtcbiAgICAgICAgLy8gSWYgYSB0YWlsYWJsZSBjdXJzb3IgY29udGFpbnMgYSBcInRzXCIgZmllbGQsIHVzZSBpdCB0byByZWNyZWF0ZSB0aGVcbiAgICAgICAgLy8gY3Vyc29yIG9uIGVycm9yLiAoXCJ0c1wiIGlzIGEgc3RhbmRhcmQgdGhhdCBNb25nbyB1c2VzIGludGVybmFsbHkgZm9yXG4gICAgICAgIC8vIHRoZSBvcGxvZywgYW5kIHRoZXJlJ3MgYSBzcGVjaWFsIGZsYWcgdGhhdCBsZXRzIHlvdSBkbyBiaW5hcnkgc2VhcmNoXG4gICAgICAgIC8vIG9uIGl0IGluc3RlYWQgb2YgbmVlZGluZyB0byB1c2UgYW4gaW5kZXguKVxuICAgICAgICBsYXN0VFMgPSBkb2MudHM7XG4gICAgICAgIGRvY0NhbGxiYWNrKGRvYyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbmV3U2VsZWN0b3IgPSBfLmNsb25lKGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKTtcbiAgICAgICAgaWYgKGxhc3RUUykge1xuICAgICAgICAgIG5ld1NlbGVjdG9yLnRzID0geyRndDogbGFzdFRTfTtcbiAgICAgICAgfVxuICAgICAgICBjdXJzb3IgPSBzZWxmLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihuZXcgQ3Vyc29yRGVzY3JpcHRpb24oXG4gICAgICAgICAgY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWUsXG4gICAgICAgICAgbmV3U2VsZWN0b3IsXG4gICAgICAgICAgY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucykpO1xuICAgICAgICAvLyBNb25nbyBmYWlsb3ZlciB0YWtlcyBtYW55IHNlY29uZHMuICBSZXRyeSBpbiBhIGJpdC4gIChXaXRob3V0IHRoaXNcbiAgICAgICAgLy8gc2V0VGltZW91dCwgd2UgcGVnIHRoZSBDUFUgYXQgMTAwJSBhbmQgbmV2ZXIgbm90aWNlIHRoZSBhY3R1YWxcbiAgICAgICAgLy8gZmFpbG92ZXIuXG4gICAgICAgIE1ldGVvci5zZXRUaW1lb3V0KGxvb3AsIDEwMCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBNZXRlb3IuZGVmZXIobG9vcCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICAgIGN1cnNvci5jbG9zZSgpO1xuICAgIH1cbiAgfTtcbn07XG5cbk1vbmdvQ29ubmVjdGlvbi5wcm90b3R5cGUuX29ic2VydmVDaGFuZ2VzID0gZnVuY3Rpb24gKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLCBvcmRlcmVkLCBjYWxsYmFja3MpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmIChjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLnRhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHNlbGYuX29ic2VydmVDaGFuZ2VzVGFpbGFibGUoY3Vyc29yRGVzY3JpcHRpb24sIG9yZGVyZWQsIGNhbGxiYWNrcyk7XG4gIH1cblxuICAvLyBZb3UgbWF5IG5vdCBmaWx0ZXIgb3V0IF9pZCB3aGVuIG9ic2VydmluZyBjaGFuZ2VzLCBiZWNhdXNlIHRoZSBpZCBpcyBhIGNvcmVcbiAgLy8gcGFydCBvZiB0aGUgb2JzZXJ2ZUNoYW5nZXMgQVBJLlxuICBpZiAoY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5maWVsZHMgJiZcbiAgICAgIChjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLmZpZWxkcy5faWQgPT09IDAgfHxcbiAgICAgICBjdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLmZpZWxkcy5faWQgPT09IGZhbHNlKSkge1xuICAgIHRocm93IEVycm9yKFwiWW91IG1heSBub3Qgb2JzZXJ2ZSBhIGN1cnNvciB3aXRoIHtmaWVsZHM6IHtfaWQ6IDB9fVwiKTtcbiAgfVxuXG4gIHZhciBvYnNlcnZlS2V5ID0gRUpTT04uc3RyaW5naWZ5KFxuICAgIF8uZXh0ZW5kKHtvcmRlcmVkOiBvcmRlcmVkfSwgY3Vyc29yRGVzY3JpcHRpb24pKTtcblxuICB2YXIgbXVsdGlwbGV4ZXIsIG9ic2VydmVEcml2ZXI7XG4gIHZhciBmaXJzdEhhbmRsZSA9IGZhbHNlO1xuXG4gIC8vIEZpbmQgYSBtYXRjaGluZyBPYnNlcnZlTXVsdGlwbGV4ZXIsIG9yIGNyZWF0ZSBhIG5ldyBvbmUuIFRoaXMgbmV4dCBibG9jayBpc1xuICAvLyBndWFyYW50ZWVkIHRvIG5vdCB5aWVsZCAoYW5kIGl0IGRvZXNuJ3QgY2FsbCBhbnl0aGluZyB0aGF0IGNhbiBvYnNlcnZlIGFcbiAgLy8gbmV3IHF1ZXJ5KSwgc28gbm8gb3RoZXIgY2FsbHMgdG8gdGhpcyBmdW5jdGlvbiBjYW4gaW50ZXJsZWF2ZSB3aXRoIGl0LlxuICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKF8uaGFzKHNlbGYuX29ic2VydmVNdWx0aXBsZXhlcnMsIG9ic2VydmVLZXkpKSB7XG4gICAgICBtdWx0aXBsZXhlciA9IHNlbGYuX29ic2VydmVNdWx0aXBsZXhlcnNbb2JzZXJ2ZUtleV07XG4gICAgfSBlbHNlIHtcbiAgICAgIGZpcnN0SGFuZGxlID0gdHJ1ZTtcbiAgICAgIC8vIENyZWF0ZSBhIG5ldyBPYnNlcnZlTXVsdGlwbGV4ZXIuXG4gICAgICBtdWx0aXBsZXhlciA9IG5ldyBPYnNlcnZlTXVsdGlwbGV4ZXIoe1xuICAgICAgICBvcmRlcmVkOiBvcmRlcmVkLFxuICAgICAgICBvblN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBkZWxldGUgc2VsZi5fb2JzZXJ2ZU11bHRpcGxleGVyc1tvYnNlcnZlS2V5XTtcbiAgICAgICAgICBvYnNlcnZlRHJpdmVyLnN0b3AoKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBzZWxmLl9vYnNlcnZlTXVsdGlwbGV4ZXJzW29ic2VydmVLZXldID0gbXVsdGlwbGV4ZXI7XG4gICAgfVxuICB9KTtcblxuICB2YXIgb2JzZXJ2ZUhhbmRsZSA9IG5ldyBPYnNlcnZlSGFuZGxlKG11bHRpcGxleGVyLCBjYWxsYmFja3MpO1xuXG4gIGlmIChmaXJzdEhhbmRsZSkge1xuICAgIHZhciBtYXRjaGVyLCBzb3J0ZXI7XG4gICAgdmFyIGNhblVzZU9wbG9nID0gXy5hbGwoW1xuICAgICAgZnVuY3Rpb24gKCkge1xuICAgICAgICAvLyBBdCBhIGJhcmUgbWluaW11bSwgdXNpbmcgdGhlIG9wbG9nIHJlcXVpcmVzIHVzIHRvIGhhdmUgYW4gb3Bsb2csIHRvXG4gICAgICAgIC8vIHdhbnQgdW5vcmRlcmVkIGNhbGxiYWNrcywgYW5kIHRvIG5vdCB3YW50IGEgY2FsbGJhY2sgb24gdGhlIHBvbGxzXG4gICAgICAgIC8vIHRoYXQgd29uJ3QgaGFwcGVuLlxuICAgICAgICByZXR1cm4gc2VsZi5fb3Bsb2dIYW5kbGUgJiYgIW9yZGVyZWQgJiZcbiAgICAgICAgICAhY2FsbGJhY2tzLl90ZXN0T25seVBvbGxDYWxsYmFjaztcbiAgICAgIH0sIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgLy8gV2UgbmVlZCB0byBiZSBhYmxlIHRvIGNvbXBpbGUgdGhlIHNlbGVjdG9yLiBGYWxsIGJhY2sgdG8gcG9sbGluZyBmb3JcbiAgICAgICAgLy8gc29tZSBuZXdmYW5nbGVkICRzZWxlY3RvciB0aGF0IG1pbmltb25nbyBkb2Vzbid0IHN1cHBvcnQgeWV0LlxuICAgICAgICB0cnkge1xuICAgICAgICAgIG1hdGNoZXIgPSBuZXcgTWluaW1vbmdvLk1hdGNoZXIoY3Vyc29yRGVzY3JpcHRpb24uc2VsZWN0b3IpO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgLy8gWFhYIG1ha2UgYWxsIGNvbXBpbGF0aW9uIGVycm9ycyBNaW5pbW9uZ29FcnJvciBvciBzb21ldGhpbmdcbiAgICAgICAgICAvLyAgICAgc28gdGhhdCB0aGlzIGRvZXNuJ3QgaWdub3JlIHVucmVsYXRlZCBleGNlcHRpb25zXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9LCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIC8vIC4uLiBhbmQgdGhlIHNlbGVjdG9yIGl0c2VsZiBuZWVkcyB0byBzdXBwb3J0IG9wbG9nLlxuICAgICAgICByZXR1cm4gT3Bsb2dPYnNlcnZlRHJpdmVyLmN1cnNvclN1cHBvcnRlZChjdXJzb3JEZXNjcmlwdGlvbiwgbWF0Y2hlcik7XG4gICAgICB9LCBmdW5jdGlvbiAoKSB7XG4gICAgICAgIC8vIEFuZCB3ZSBuZWVkIHRvIGJlIGFibGUgdG8gY29tcGlsZSB0aGUgc29ydCwgaWYgYW55LiAgZWcsIGNhbid0IGJlXG4gICAgICAgIC8vIHskbmF0dXJhbDogMX0uXG4gICAgICAgIGlmICghY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5zb3J0KVxuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHNvcnRlciA9IG5ldyBNaW5pbW9uZ28uU29ydGVyKGN1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMuc29ydCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IG1hdGNoZXI6IG1hdGNoZXIgfSk7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBYWFggbWFrZSBhbGwgY29tcGlsYXRpb24gZXJyb3JzIE1pbmltb25nb0Vycm9yIG9yIHNvbWV0aGluZ1xuICAgICAgICAgIC8vICAgICBzbyB0aGF0IHRoaXMgZG9lc24ndCBpZ25vcmUgdW5yZWxhdGVkIGV4Y2VwdGlvbnNcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1dLCBmdW5jdGlvbiAoZikgeyByZXR1cm4gZigpOyB9KTsgIC8vIGludm9rZSBlYWNoIGZ1bmN0aW9uXG5cbiAgICB2YXIgZHJpdmVyQ2xhc3MgPSBjYW5Vc2VPcGxvZyA/IE9wbG9nT2JzZXJ2ZURyaXZlciA6IFBvbGxpbmdPYnNlcnZlRHJpdmVyO1xuICAgIG9ic2VydmVEcml2ZXIgPSBuZXcgZHJpdmVyQ2xhc3Moe1xuICAgICAgY3Vyc29yRGVzY3JpcHRpb246IGN1cnNvckRlc2NyaXB0aW9uLFxuICAgICAgbW9uZ29IYW5kbGU6IHNlbGYsXG4gICAgICBtdWx0aXBsZXhlcjogbXVsdGlwbGV4ZXIsXG4gICAgICBvcmRlcmVkOiBvcmRlcmVkLFxuICAgICAgbWF0Y2hlcjogbWF0Y2hlciwgIC8vIGlnbm9yZWQgYnkgcG9sbGluZ1xuICAgICAgc29ydGVyOiBzb3J0ZXIsICAvLyBpZ25vcmVkIGJ5IHBvbGxpbmdcbiAgICAgIF90ZXN0T25seVBvbGxDYWxsYmFjazogY2FsbGJhY2tzLl90ZXN0T25seVBvbGxDYWxsYmFja1xuICAgIH0pO1xuXG4gICAgLy8gVGhpcyBmaWVsZCBpcyBvbmx5IHNldCBmb3IgdXNlIGluIHRlc3RzLlxuICAgIG11bHRpcGxleGVyLl9vYnNlcnZlRHJpdmVyID0gb2JzZXJ2ZURyaXZlcjtcbiAgfVxuXG4gIC8vIEJsb2NrcyB1bnRpbCB0aGUgaW5pdGlhbCBhZGRzIGhhdmUgYmVlbiBzZW50LlxuICBtdWx0aXBsZXhlci5hZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMob2JzZXJ2ZUhhbmRsZSk7XG5cbiAgcmV0dXJuIG9ic2VydmVIYW5kbGU7XG59O1xuXG4vLyBMaXN0ZW4gZm9yIHRoZSBpbnZhbGlkYXRpb24gbWVzc2FnZXMgdGhhdCB3aWxsIHRyaWdnZXIgdXMgdG8gcG9sbCB0aGVcbi8vIGRhdGFiYXNlIGZvciBjaGFuZ2VzLiBJZiB0aGlzIHNlbGVjdG9yIHNwZWNpZmllcyBzcGVjaWZpYyBJRHMsIHNwZWNpZnkgdGhlbVxuLy8gaGVyZSwgc28gdGhhdCB1cGRhdGVzIHRvIGRpZmZlcmVudCBzcGVjaWZpYyBJRHMgZG9uJ3QgY2F1c2UgdXMgdG8gcG9sbC5cbi8vIGxpc3RlbkNhbGxiYWNrIGlzIHRoZSBzYW1lIGtpbmQgb2YgKG5vdGlmaWNhdGlvbiwgY29tcGxldGUpIGNhbGxiYWNrIHBhc3NlZFxuLy8gdG8gSW52YWxpZGF0aW9uQ3Jvc3NiYXIubGlzdGVuLlxuXG5saXN0ZW5BbGwgPSBmdW5jdGlvbiAoY3Vyc29yRGVzY3JpcHRpb24sIGxpc3RlbkNhbGxiYWNrKSB7XG4gIHZhciBsaXN0ZW5lcnMgPSBbXTtcbiAgZm9yRWFjaFRyaWdnZXIoY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uICh0cmlnZ2VyKSB7XG4gICAgbGlzdGVuZXJzLnB1c2goRERQU2VydmVyLl9JbnZhbGlkYXRpb25Dcm9zc2Jhci5saXN0ZW4oXG4gICAgICB0cmlnZ2VyLCBsaXN0ZW5DYWxsYmFjaykpO1xuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHN0b3A6IGZ1bmN0aW9uICgpIHtcbiAgICAgIF8uZWFjaChsaXN0ZW5lcnMsIGZ1bmN0aW9uIChsaXN0ZW5lcikge1xuICAgICAgICBsaXN0ZW5lci5zdG9wKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH07XG59O1xuXG5mb3JFYWNoVHJpZ2dlciA9IGZ1bmN0aW9uIChjdXJzb3JEZXNjcmlwdGlvbiwgdHJpZ2dlckNhbGxiYWNrKSB7XG4gIHZhciBrZXkgPSB7Y29sbGVjdGlvbjogY3Vyc29yRGVzY3JpcHRpb24uY29sbGVjdGlvbk5hbWV9O1xuICB2YXIgc3BlY2lmaWNJZHMgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKFxuICAgIGN1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKTtcbiAgaWYgKHNwZWNpZmljSWRzKSB7XG4gICAgXy5lYWNoKHNwZWNpZmljSWRzLCBmdW5jdGlvbiAoaWQpIHtcbiAgICAgIHRyaWdnZXJDYWxsYmFjayhfLmV4dGVuZCh7aWQ6IGlkfSwga2V5KSk7XG4gICAgfSk7XG4gICAgdHJpZ2dlckNhbGxiYWNrKF8uZXh0ZW5kKHtkcm9wQ29sbGVjdGlvbjogdHJ1ZSwgaWQ6IG51bGx9LCBrZXkpKTtcbiAgfSBlbHNlIHtcbiAgICB0cmlnZ2VyQ2FsbGJhY2soa2V5KTtcbiAgfVxuICAvLyBFdmVyeW9uZSBjYXJlcyBhYm91dCB0aGUgZGF0YWJhc2UgYmVpbmcgZHJvcHBlZC5cbiAgdHJpZ2dlckNhbGxiYWNrKHsgZHJvcERhdGFiYXNlOiB0cnVlIH0pO1xufTtcblxuLy8gb2JzZXJ2ZUNoYW5nZXMgZm9yIHRhaWxhYmxlIGN1cnNvcnMgb24gY2FwcGVkIGNvbGxlY3Rpb25zLlxuLy9cbi8vIFNvbWUgZGlmZmVyZW5jZXMgZnJvbSBub3JtYWwgY3Vyc29yczpcbi8vICAgLSBXaWxsIG5ldmVyIHByb2R1Y2UgYW55dGhpbmcgb3RoZXIgdGhhbiAnYWRkZWQnIG9yICdhZGRlZEJlZm9yZScuIElmIHlvdVxuLy8gICAgIGRvIHVwZGF0ZSBhIGRvY3VtZW50IHRoYXQgaGFzIGFscmVhZHkgYmVlbiBwcm9kdWNlZCwgdGhpcyB3aWxsIG5vdCBub3RpY2Vcbi8vICAgICBpdC5cbi8vICAgLSBJZiB5b3UgZGlzY29ubmVjdCBhbmQgcmVjb25uZWN0IGZyb20gTW9uZ28sIGl0IHdpbGwgZXNzZW50aWFsbHkgcmVzdGFydFxuLy8gICAgIHRoZSBxdWVyeSwgd2hpY2ggd2lsbCBsZWFkIHRvIGR1cGxpY2F0ZSByZXN1bHRzLiBUaGlzIGlzIHByZXR0eSBiYWQsXG4vLyAgICAgYnV0IGlmIHlvdSBpbmNsdWRlIGEgZmllbGQgY2FsbGVkICd0cycgd2hpY2ggaXMgaW5zZXJ0ZWQgYXNcbi8vICAgICBuZXcgTW9uZ29JbnRlcm5hbHMuTW9uZ29UaW1lc3RhbXAoMCwgMCkgKHdoaWNoIGlzIGluaXRpYWxpemVkIHRvIHRoZVxuLy8gICAgIGN1cnJlbnQgTW9uZ28tc3R5bGUgdGltZXN0YW1wKSwgd2UnbGwgYmUgYWJsZSB0byBmaW5kIHRoZSBwbGFjZSB0b1xuLy8gICAgIHJlc3RhcnQgcHJvcGVybHkuIChUaGlzIGZpZWxkIGlzIHNwZWNpZmljYWxseSB1bmRlcnN0b29kIGJ5IE1vbmdvIHdpdGggYW5cbi8vICAgICBvcHRpbWl6YXRpb24gd2hpY2ggYWxsb3dzIGl0IHRvIGZpbmQgdGhlIHJpZ2h0IHBsYWNlIHRvIHN0YXJ0IHdpdGhvdXRcbi8vICAgICBhbiBpbmRleCBvbiB0cy4gSXQncyBob3cgdGhlIG9wbG9nIHdvcmtzLilcbi8vICAgLSBObyBjYWxsYmFja3MgYXJlIHRyaWdnZXJlZCBzeW5jaHJvbm91c2x5IHdpdGggdGhlIGNhbGwgKHRoZXJlJ3Mgbm9cbi8vICAgICBkaWZmZXJlbnRpYXRpb24gYmV0d2VlbiBcImluaXRpYWwgZGF0YVwiIGFuZCBcImxhdGVyIGNoYW5nZXNcIjsgZXZlcnl0aGluZ1xuLy8gICAgIHRoYXQgbWF0Y2hlcyB0aGUgcXVlcnkgZ2V0cyBzZW50IGFzeW5jaHJvbm91c2x5KS5cbi8vICAgLSBEZS1kdXBsaWNhdGlvbiBpcyBub3QgaW1wbGVtZW50ZWQuXG4vLyAgIC0gRG9lcyBub3QgeWV0IGludGVyYWN0IHdpdGggdGhlIHdyaXRlIGZlbmNlLiBQcm9iYWJseSwgdGhpcyBzaG91bGQgd29yayBieVxuLy8gICAgIGlnbm9yaW5nIHJlbW92ZXMgKHdoaWNoIGRvbid0IHdvcmsgb24gY2FwcGVkIGNvbGxlY3Rpb25zKSBhbmQgdXBkYXRlc1xuLy8gICAgICh3aGljaCBkb24ndCBhZmZlY3QgdGFpbGFibGUgY3Vyc29ycyksIGFuZCBqdXN0IGtlZXBpbmcgdHJhY2sgb2YgdGhlIElEXG4vLyAgICAgb2YgdGhlIGluc2VydGVkIG9iamVjdCwgYW5kIGNsb3NpbmcgdGhlIHdyaXRlIGZlbmNlIG9uY2UgeW91IGdldCB0byB0aGF0XG4vLyAgICAgSUQgKG9yIHRpbWVzdGFtcD8pLiAgVGhpcyBkb2Vzbid0IHdvcmsgd2VsbCBpZiB0aGUgZG9jdW1lbnQgZG9lc24ndCBtYXRjaFxuLy8gICAgIHRoZSBxdWVyeSwgdGhvdWdoLiAgT24gdGhlIG90aGVyIGhhbmQsIHRoZSB3cml0ZSBmZW5jZSBjYW4gY2xvc2Vcbi8vICAgICBpbW1lZGlhdGVseSBpZiBpdCBkb2VzIG5vdCBtYXRjaCB0aGUgcXVlcnkuIFNvIGlmIHdlIHRydXN0IG1pbmltb25nb1xuLy8gICAgIGVub3VnaCB0byBhY2N1cmF0ZWx5IGV2YWx1YXRlIHRoZSBxdWVyeSBhZ2FpbnN0IHRoZSB3cml0ZSBmZW5jZSwgd2Vcbi8vICAgICBzaG91bGQgYmUgYWJsZSB0byBkbyB0aGlzLi4uICBPZiBjb3Vyc2UsIG1pbmltb25nbyBkb2Vzbid0IGV2ZW4gc3VwcG9ydFxuLy8gICAgIE1vbmdvIFRpbWVzdGFtcHMgeWV0LlxuTW9uZ29Db25uZWN0aW9uLnByb3RvdHlwZS5fb2JzZXJ2ZUNoYW5nZXNUYWlsYWJsZSA9IGZ1bmN0aW9uIChcbiAgICBjdXJzb3JEZXNjcmlwdGlvbiwgb3JkZXJlZCwgY2FsbGJhY2tzKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICAvLyBUYWlsYWJsZSBjdXJzb3JzIG9ubHkgZXZlciBjYWxsIGFkZGVkL2FkZGVkQmVmb3JlIGNhbGxiYWNrcywgc28gaXQncyBhblxuICAvLyBlcnJvciBpZiB5b3UgZGlkbid0IHByb3ZpZGUgdGhlbS5cbiAgaWYgKChvcmRlcmVkICYmICFjYWxsYmFja3MuYWRkZWRCZWZvcmUpIHx8XG4gICAgICAoIW9yZGVyZWQgJiYgIWNhbGxiYWNrcy5hZGRlZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4ndCBvYnNlcnZlIGFuIFwiICsgKG9yZGVyZWQgPyBcIm9yZGVyZWRcIiA6IFwidW5vcmRlcmVkXCIpXG4gICAgICAgICAgICAgICAgICAgICsgXCIgdGFpbGFibGUgY3Vyc29yIHdpdGhvdXQgYSBcIlxuICAgICAgICAgICAgICAgICAgICArIChvcmRlcmVkID8gXCJhZGRlZEJlZm9yZVwiIDogXCJhZGRlZFwiKSArIFwiIGNhbGxiYWNrXCIpO1xuICB9XG5cbiAgcmV0dXJuIHNlbGYudGFpbChjdXJzb3JEZXNjcmlwdGlvbiwgZnVuY3Rpb24gKGRvYykge1xuICAgIHZhciBpZCA9IGRvYy5faWQ7XG4gICAgZGVsZXRlIGRvYy5faWQ7XG4gICAgLy8gVGhlIHRzIGlzIGFuIGltcGxlbWVudGF0aW9uIGRldGFpbC4gSGlkZSBpdC5cbiAgICBkZWxldGUgZG9jLnRzO1xuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICBjYWxsYmFja3MuYWRkZWRCZWZvcmUoaWQsIGRvYywgbnVsbCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNhbGxiYWNrcy5hZGRlZChpZCwgZG9jKTtcbiAgICB9XG4gIH0pO1xufTtcblxuLy8gWFhYIFdlIHByb2JhYmx5IG5lZWQgdG8gZmluZCBhIGJldHRlciB3YXkgdG8gZXhwb3NlIHRoaXMuIFJpZ2h0IG5vd1xuLy8gaXQncyBvbmx5IHVzZWQgYnkgdGVzdHMsIGJ1dCBpbiBmYWN0IHlvdSBuZWVkIGl0IGluIG5vcm1hbFxuLy8gb3BlcmF0aW9uIHRvIGludGVyYWN0IHdpdGggY2FwcGVkIGNvbGxlY3Rpb25zLlxuTW9uZ29JbnRlcm5hbHMuTW9uZ29UaW1lc3RhbXAgPSBNb25nb0RCLlRpbWVzdGFtcDtcblxuTW9uZ29JbnRlcm5hbHMuQ29ubmVjdGlvbiA9IE1vbmdvQ29ubmVjdGlvbjtcbiIsInZhciBGdXR1cmUgPSBOcG0ucmVxdWlyZSgnZmliZXJzL2Z1dHVyZScpO1xuXG5PUExPR19DT0xMRUNUSU9OID0gJ29wbG9nLnJzJztcblxudmFyIFRPT19GQVJfQkVISU5EID0gcHJvY2Vzcy5lbnYuTUVURU9SX09QTE9HX1RPT19GQVJfQkVISU5EIHx8IDIwMDA7XG5cbnZhciBzaG93VFMgPSBmdW5jdGlvbiAodHMpIHtcbiAgcmV0dXJuIFwiVGltZXN0YW1wKFwiICsgdHMuZ2V0SGlnaEJpdHMoKSArIFwiLCBcIiArIHRzLmdldExvd0JpdHMoKSArIFwiKVwiO1xufTtcblxuaWRGb3JPcCA9IGZ1bmN0aW9uIChvcCkge1xuICBpZiAob3Aub3AgPT09ICdkJylcbiAgICByZXR1cm4gb3Auby5faWQ7XG4gIGVsc2UgaWYgKG9wLm9wID09PSAnaScpXG4gICAgcmV0dXJuIG9wLm8uX2lkO1xuICBlbHNlIGlmIChvcC5vcCA9PT0gJ3UnKVxuICAgIHJldHVybiBvcC5vMi5faWQ7XG4gIGVsc2UgaWYgKG9wLm9wID09PSAnYycpXG4gICAgdGhyb3cgRXJyb3IoXCJPcGVyYXRvciAnYycgZG9lc24ndCBzdXBwbHkgYW4gb2JqZWN0IHdpdGggaWQ6IFwiICtcbiAgICAgICAgICAgICAgICBFSlNPTi5zdHJpbmdpZnkob3ApKTtcbiAgZWxzZVxuICAgIHRocm93IEVycm9yKFwiVW5rbm93biBvcDogXCIgKyBFSlNPTi5zdHJpbmdpZnkob3ApKTtcbn07XG5cbk9wbG9nSGFuZGxlID0gZnVuY3Rpb24gKG9wbG9nVXJsLCBkYk5hbWUpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLl9vcGxvZ1VybCA9IG9wbG9nVXJsO1xuICBzZWxmLl9kYk5hbWUgPSBkYk5hbWU7XG5cbiAgc2VsZi5fb3Bsb2dMYXN0RW50cnlDb25uZWN0aW9uID0gbnVsbDtcbiAgc2VsZi5fb3Bsb2dUYWlsQ29ubmVjdGlvbiA9IG51bGw7XG4gIHNlbGYuX3N0b3BwZWQgPSBmYWxzZTtcbiAgc2VsZi5fdGFpbEhhbmRsZSA9IG51bGw7XG4gIHNlbGYuX3JlYWR5RnV0dXJlID0gbmV3IEZ1dHVyZSgpO1xuICBzZWxmLl9jcm9zc2JhciA9IG5ldyBERFBTZXJ2ZXIuX0Nyb3NzYmFyKHtcbiAgICBmYWN0UGFja2FnZTogXCJtb25nby1saXZlZGF0YVwiLCBmYWN0TmFtZTogXCJvcGxvZy13YXRjaGVyc1wiXG4gIH0pO1xuICBzZWxmLl9iYXNlT3Bsb2dTZWxlY3RvciA9IHtcbiAgICBuczogbmV3IFJlZ0V4cCgnXicgKyBNZXRlb3IuX2VzY2FwZVJlZ0V4cChzZWxmLl9kYk5hbWUpICsgJ1xcXFwuJyksXG4gICAgJG9yOiBbXG4gICAgICB7IG9wOiB7JGluOiBbJ2knLCAndScsICdkJ119IH0sXG4gICAgICAvLyBkcm9wIGNvbGxlY3Rpb25cbiAgICAgIHsgb3A6ICdjJywgJ28uZHJvcCc6IHsgJGV4aXN0czogdHJ1ZSB9IH0sXG4gICAgICB7IG9wOiAnYycsICdvLmRyb3BEYXRhYmFzZSc6IDEgfSxcbiAgICBdXG4gIH07XG5cbiAgLy8gRGF0YSBzdHJ1Y3R1cmVzIHRvIHN1cHBvcnQgd2FpdFVudGlsQ2F1Z2h0VXAoKS4gRWFjaCBvcGxvZyBlbnRyeSBoYXMgYVxuICAvLyBNb25nb1RpbWVzdGFtcCBvYmplY3Qgb24gaXQgKHdoaWNoIGlzIG5vdCB0aGUgc2FtZSBhcyBhIERhdGUgLS0tIGl0J3MgYVxuICAvLyBjb21iaW5hdGlvbiBvZiB0aW1lIGFuZCBhbiBpbmNyZW1lbnRpbmcgY291bnRlcjsgc2VlXG4gIC8vIGh0dHA6Ly9kb2NzLm1vbmdvZGIub3JnL21hbnVhbC9yZWZlcmVuY2UvYnNvbi10eXBlcy8jdGltZXN0YW1wcykuXG4gIC8vXG4gIC8vIF9jYXRjaGluZ1VwRnV0dXJlcyBpcyBhbiBhcnJheSBvZiB7dHM6IE1vbmdvVGltZXN0YW1wLCBmdXR1cmU6IEZ1dHVyZX1cbiAgLy8gb2JqZWN0cywgc29ydGVkIGJ5IGFzY2VuZGluZyB0aW1lc3RhbXAuIF9sYXN0UHJvY2Vzc2VkVFMgaXMgdGhlXG4gIC8vIE1vbmdvVGltZXN0YW1wIG9mIHRoZSBsYXN0IG9wbG9nIGVudHJ5IHdlJ3ZlIHByb2Nlc3NlZC5cbiAgLy9cbiAgLy8gRWFjaCB0aW1lIHdlIGNhbGwgd2FpdFVudGlsQ2F1Z2h0VXAsIHdlIHRha2UgYSBwZWVrIGF0IHRoZSBmaW5hbCBvcGxvZ1xuICAvLyBlbnRyeSBpbiB0aGUgZGIuICBJZiB3ZSd2ZSBhbHJlYWR5IHByb2Nlc3NlZCBpdCAoaWUsIGl0IGlzIG5vdCBncmVhdGVyIHRoYW5cbiAgLy8gX2xhc3RQcm9jZXNzZWRUUyksIHdhaXRVbnRpbENhdWdodFVwIGltbWVkaWF0ZWx5IHJldHVybnMuIE90aGVyd2lzZSxcbiAgLy8gd2FpdFVudGlsQ2F1Z2h0VXAgbWFrZXMgYSBuZXcgRnV0dXJlIGFuZCBpbnNlcnRzIGl0IGFsb25nIHdpdGggdGhlIGZpbmFsXG4gIC8vIHRpbWVzdGFtcCBlbnRyeSB0aGF0IGl0IHJlYWQsIGludG8gX2NhdGNoaW5nVXBGdXR1cmVzLiB3YWl0VW50aWxDYXVnaHRVcFxuICAvLyB0aGVuIHdhaXRzIG9uIHRoYXQgZnV0dXJlLCB3aGljaCBpcyByZXNvbHZlZCBvbmNlIF9sYXN0UHJvY2Vzc2VkVFMgaXNcbiAgLy8gaW5jcmVtZW50ZWQgdG8gYmUgcGFzdCBpdHMgdGltZXN0YW1wIGJ5IHRoZSB3b3JrZXIgZmliZXIuXG4gIC8vXG4gIC8vIFhYWCB1c2UgYSBwcmlvcml0eSBxdWV1ZSBvciBzb21ldGhpbmcgZWxzZSB0aGF0J3MgZmFzdGVyIHRoYW4gYW4gYXJyYXlcbiAgc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMgPSBbXTtcbiAgc2VsZi5fbGFzdFByb2Nlc3NlZFRTID0gbnVsbDtcblxuICBzZWxmLl9vblNraXBwZWRFbnRyaWVzSG9vayA9IG5ldyBIb29rKHtcbiAgICBkZWJ1Z1ByaW50RXhjZXB0aW9uczogXCJvblNraXBwZWRFbnRyaWVzIGNhbGxiYWNrXCJcbiAgfSk7XG5cbiAgc2VsZi5fZW50cnlRdWV1ZSA9IG5ldyBNZXRlb3IuX0RvdWJsZUVuZGVkUXVldWUoKTtcbiAgc2VsZi5fd29ya2VyQWN0aXZlID0gZmFsc2U7XG5cbiAgc2VsZi5fc3RhcnRUYWlsaW5nKCk7XG59O1xuXG5fLmV4dGVuZChPcGxvZ0hhbmRsZS5wcm90b3R5cGUsIHtcbiAgc3RvcDogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHJldHVybjtcbiAgICBzZWxmLl9zdG9wcGVkID0gdHJ1ZTtcbiAgICBpZiAoc2VsZi5fdGFpbEhhbmRsZSlcbiAgICAgIHNlbGYuX3RhaWxIYW5kbGUuc3RvcCgpO1xuICAgIC8vIFhYWCBzaG91bGQgY2xvc2UgY29ubmVjdGlvbnMgdG9vXG4gIH0sXG4gIG9uT3Bsb2dFbnRyeTogZnVuY3Rpb24gKHRyaWdnZXIsIGNhbGxiYWNrKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FsbGVkIG9uT3Bsb2dFbnRyeSBvbiBzdG9wcGVkIGhhbmRsZSFcIik7XG5cbiAgICAvLyBDYWxsaW5nIG9uT3Bsb2dFbnRyeSByZXF1aXJlcyB1cyB0byB3YWl0IGZvciB0aGUgdGFpbGluZyB0byBiZSByZWFkeS5cbiAgICBzZWxmLl9yZWFkeUZ1dHVyZS53YWl0KCk7XG5cbiAgICB2YXIgb3JpZ2luYWxDYWxsYmFjayA9IGNhbGxiYWNrO1xuICAgIGNhbGxiYWNrID0gTWV0ZW9yLmJpbmRFbnZpcm9ubWVudChmdW5jdGlvbiAobm90aWZpY2F0aW9uKSB7XG4gICAgICAvLyBYWFggY2FuIHdlIGF2b2lkIHRoaXMgY2xvbmUgYnkgbWFraW5nIG9wbG9nLmpzIGNhcmVmdWw/XG4gICAgICBvcmlnaW5hbENhbGxiYWNrKEVKU09OLmNsb25lKG5vdGlmaWNhdGlvbikpO1xuICAgIH0sIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgIE1ldGVvci5fZGVidWcoXCJFcnJvciBpbiBvcGxvZyBjYWxsYmFja1wiLCBlcnIuc3RhY2spO1xuICAgIH0pO1xuICAgIHZhciBsaXN0ZW5IYW5kbGUgPSBzZWxmLl9jcm9zc2Jhci5saXN0ZW4odHJpZ2dlciwgY2FsbGJhY2spO1xuICAgIHJldHVybiB7XG4gICAgICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGxpc3RlbkhhbmRsZS5zdG9wKCk7XG4gICAgICB9XG4gICAgfTtcbiAgfSxcbiAgLy8gUmVnaXN0ZXIgYSBjYWxsYmFjayB0byBiZSBpbnZva2VkIGFueSB0aW1lIHdlIHNraXAgb3Bsb2cgZW50cmllcyAoZWcsXG4gIC8vIGJlY2F1c2Ugd2UgYXJlIHRvbyBmYXIgYmVoaW5kKS5cbiAgb25Ta2lwcGVkRW50cmllczogZnVuY3Rpb24gKGNhbGxiYWNrKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FsbGVkIG9uU2tpcHBlZEVudHJpZXMgb24gc3RvcHBlZCBoYW5kbGUhXCIpO1xuICAgIHJldHVybiBzZWxmLl9vblNraXBwZWRFbnRyaWVzSG9vay5yZWdpc3RlcihjYWxsYmFjayk7XG4gIH0sXG4gIC8vIENhbGxzIGBjYWxsYmFja2Agb25jZSB0aGUgb3Bsb2cgaGFzIGJlZW4gcHJvY2Vzc2VkIHVwIHRvIGEgcG9pbnQgdGhhdCBpc1xuICAvLyByb3VnaGx5IFwibm93XCI6IHNwZWNpZmljYWxseSwgb25jZSB3ZSd2ZSBwcm9jZXNzZWQgYWxsIG9wcyB0aGF0IGFyZVxuICAvLyBjdXJyZW50bHkgdmlzaWJsZS5cbiAgLy8gWFhYIGJlY29tZSBjb252aW5jZWQgdGhhdCB0aGlzIGlzIGFjdHVhbGx5IHNhZmUgZXZlbiBpZiBvcGxvZ0Nvbm5lY3Rpb25cbiAgLy8gaXMgc29tZSBraW5kIG9mIHBvb2xcbiAgd2FpdFVudGlsQ2F1Z2h0VXA6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYWxsZWQgd2FpdFVudGlsQ2F1Z2h0VXAgb24gc3RvcHBlZCBoYW5kbGUhXCIpO1xuXG4gICAgLy8gQ2FsbGluZyB3YWl0VW50aWxDYXVnaHRVcCByZXF1cmllcyB1cyB0byB3YWl0IGZvciB0aGUgb3Bsb2cgY29ubmVjdGlvbiB0b1xuICAgIC8vIGJlIHJlYWR5LlxuICAgIHNlbGYuX3JlYWR5RnV0dXJlLndhaXQoKTtcbiAgICB2YXIgbGFzdEVudHJ5O1xuXG4gICAgd2hpbGUgKCFzZWxmLl9zdG9wcGVkKSB7XG4gICAgICAvLyBXZSBuZWVkIHRvIG1ha2UgdGhlIHNlbGVjdG9yIGF0IGxlYXN0IGFzIHJlc3RyaWN0aXZlIGFzIHRoZSBhY3R1YWxcbiAgICAgIC8vIHRhaWxpbmcgc2VsZWN0b3IgKGllLCB3ZSBuZWVkIHRvIHNwZWNpZnkgdGhlIERCIG5hbWUpIG9yIGVsc2Ugd2UgbWlnaHRcbiAgICAgIC8vIGZpbmQgYSBUUyB0aGF0IHdvbid0IHNob3cgdXAgaW4gdGhlIGFjdHVhbCB0YWlsIHN0cmVhbS5cbiAgICAgIHRyeSB7XG4gICAgICAgIGxhc3RFbnRyeSA9IHNlbGYuX29wbG9nTGFzdEVudHJ5Q29ubmVjdGlvbi5maW5kT25lKFxuICAgICAgICAgIE9QTE9HX0NPTExFQ1RJT04sIHNlbGYuX2Jhc2VPcGxvZ1NlbGVjdG9yLFxuICAgICAgICAgIHtmaWVsZHM6IHt0czogMX0sIHNvcnQ6IHskbmF0dXJhbDogLTF9fSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBEdXJpbmcgZmFpbG92ZXIgKGVnKSBpZiB3ZSBnZXQgYW4gZXhjZXB0aW9uIHdlIHNob3VsZCBsb2cgYW5kIHJldHJ5XG4gICAgICAgIC8vIGluc3RlYWQgb2YgY3Jhc2hpbmcuXG4gICAgICAgIE1ldGVvci5fZGVidWcoXCJHb3QgZXhjZXB0aW9uIHdoaWxlIHJlYWRpbmcgbGFzdCBlbnRyeTogXCIgKyBlKTtcbiAgICAgICAgTWV0ZW9yLl9zbGVlcEZvck1zKDEwMCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG5cbiAgICBpZiAoIWxhc3RFbnRyeSkge1xuICAgICAgLy8gUmVhbGx5LCBub3RoaW5nIGluIHRoZSBvcGxvZz8gV2VsbCwgd2UndmUgcHJvY2Vzc2VkIGV2ZXJ5dGhpbmcuXG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgdmFyIHRzID0gbGFzdEVudHJ5LnRzO1xuICAgIGlmICghdHMpXG4gICAgICB0aHJvdyBFcnJvcihcIm9wbG9nIGVudHJ5IHdpdGhvdXQgdHM6IFwiICsgRUpTT04uc3RyaW5naWZ5KGxhc3RFbnRyeSkpO1xuXG4gICAgaWYgKHNlbGYuX2xhc3RQcm9jZXNzZWRUUyAmJiB0cy5sZXNzVGhhbk9yRXF1YWwoc2VsZi5fbGFzdFByb2Nlc3NlZFRTKSkge1xuICAgICAgLy8gV2UndmUgYWxyZWFkeSBjYXVnaHQgdXAgdG8gaGVyZS5cbiAgICAgIHJldHVybjtcbiAgICB9XG5cblxuICAgIC8vIEluc2VydCB0aGUgZnV0dXJlIGludG8gb3VyIGxpc3QuIEFsbW9zdCBhbHdheXMsIHRoaXMgd2lsbCBiZSBhdCB0aGUgZW5kLFxuICAgIC8vIGJ1dCBpdCdzIGNvbmNlaXZhYmxlIHRoYXQgaWYgd2UgZmFpbCBvdmVyIGZyb20gb25lIHByaW1hcnkgdG8gYW5vdGhlcixcbiAgICAvLyB0aGUgb3Bsb2cgZW50cmllcyB3ZSBzZWUgd2lsbCBnbyBiYWNrd2FyZHMuXG4gICAgdmFyIGluc2VydEFmdGVyID0gc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMubGVuZ3RoO1xuICAgIHdoaWxlIChpbnNlcnRBZnRlciAtIDEgPiAwICYmIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzW2luc2VydEFmdGVyIC0gMV0udHMuZ3JlYXRlclRoYW4odHMpKSB7XG4gICAgICBpbnNlcnRBZnRlci0tO1xuICAgIH1cbiAgICB2YXIgZiA9IG5ldyBGdXR1cmU7XG4gICAgc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMuc3BsaWNlKGluc2VydEFmdGVyLCAwLCB7dHM6IHRzLCBmdXR1cmU6IGZ9KTtcbiAgICBmLndhaXQoKTtcbiAgfSxcbiAgX3N0YXJ0VGFpbGluZzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAvLyBGaXJzdCwgbWFrZSBzdXJlIHRoYXQgd2UncmUgdGFsa2luZyB0byB0aGUgbG9jYWwgZGF0YWJhc2UuXG4gICAgdmFyIG1vbmdvZGJVcmkgPSBOcG0ucmVxdWlyZSgnbW9uZ29kYi11cmknKTtcbiAgICBpZiAobW9uZ29kYlVyaS5wYXJzZShzZWxmLl9vcGxvZ1VybCkuZGF0YWJhc2UgIT09ICdsb2NhbCcpIHtcbiAgICAgIHRocm93IEVycm9yKFwiJE1PTkdPX09QTE9HX1VSTCBtdXN0IGJlIHNldCB0byB0aGUgJ2xvY2FsJyBkYXRhYmFzZSBvZiBcIiArXG4gICAgICAgICAgICAgICAgICBcImEgTW9uZ28gcmVwbGljYSBzZXRcIik7XG4gICAgfVxuXG4gICAgLy8gV2UgbWFrZSB0d28gc2VwYXJhdGUgY29ubmVjdGlvbnMgdG8gTW9uZ28uIFRoZSBOb2RlIE1vbmdvIGRyaXZlclxuICAgIC8vIGltcGxlbWVudHMgYSBuYWl2ZSByb3VuZC1yb2JpbiBjb25uZWN0aW9uIHBvb2w6IGVhY2ggXCJjb25uZWN0aW9uXCIgaXMgYVxuICAgIC8vIHBvb2wgb2Ygc2V2ZXJhbCAoNSBieSBkZWZhdWx0KSBUQ1AgY29ubmVjdGlvbnMsIGFuZCBlYWNoIHJlcXVlc3QgaXNcbiAgICAvLyByb3RhdGVkIHRocm91Z2ggdGhlIHBvb2xzLiBUYWlsYWJsZSBjdXJzb3IgcXVlcmllcyBibG9jayBvbiB0aGUgc2VydmVyXG4gICAgLy8gdW50aWwgdGhlcmUgaXMgc29tZSBkYXRhIHRvIHJldHVybiAob3IgdW50aWwgYSBmZXcgc2Vjb25kcyBoYXZlXG4gICAgLy8gcGFzc2VkKS4gU28gaWYgdGhlIGNvbm5lY3Rpb24gcG9vbCB1c2VkIGZvciB0YWlsaW5nIGN1cnNvcnMgaXMgdGhlIHNhbWVcbiAgICAvLyBwb29sIHVzZWQgZm9yIG90aGVyIHF1ZXJpZXMsIHRoZSBvdGhlciBxdWVyaWVzIHdpbGwgYmUgZGVsYXllZCBieSBzZWNvbmRzXG4gICAgLy8gMS81IG9mIHRoZSB0aW1lLlxuICAgIC8vXG4gICAgLy8gVGhlIHRhaWwgY29ubmVjdGlvbiB3aWxsIG9ubHkgZXZlciBiZSBydW5uaW5nIGEgc2luZ2xlIHRhaWwgY29tbWFuZCwgc29cbiAgICAvLyBpdCBvbmx5IG5lZWRzIHRvIG1ha2Ugb25lIHVuZGVybHlpbmcgVENQIGNvbm5lY3Rpb24uXG4gICAgc2VsZi5fb3Bsb2dUYWlsQ29ubmVjdGlvbiA9IG5ldyBNb25nb0Nvbm5lY3Rpb24oXG4gICAgICBzZWxmLl9vcGxvZ1VybCwge3Bvb2xTaXplOiAxfSk7XG4gICAgLy8gWFhYIGJldHRlciBkb2NzLCBidXQ6IGl0J3MgdG8gZ2V0IG1vbm90b25pYyByZXN1bHRzXG4gICAgLy8gWFhYIGlzIGl0IHNhZmUgdG8gc2F5IFwiaWYgdGhlcmUncyBhbiBpbiBmbGlnaHQgcXVlcnksIGp1c3QgdXNlIGl0c1xuICAgIC8vICAgICByZXN1bHRzXCI/IEkgZG9uJ3QgdGhpbmsgc28gYnV0IHNob3VsZCBjb25zaWRlciB0aGF0XG4gICAgc2VsZi5fb3Bsb2dMYXN0RW50cnlDb25uZWN0aW9uID0gbmV3IE1vbmdvQ29ubmVjdGlvbihcbiAgICAgIHNlbGYuX29wbG9nVXJsLCB7cG9vbFNpemU6IDF9KTtcblxuICAgIC8vIE5vdywgbWFrZSBzdXJlIHRoYXQgdGhlcmUgYWN0dWFsbHkgaXMgYSByZXBsIHNldCBoZXJlLiBJZiBub3QsIG9wbG9nXG4gICAgLy8gdGFpbGluZyB3b24ndCBldmVyIGZpbmQgYW55dGhpbmchXG4gICAgLy8gTW9yZSBvbiB0aGUgaXNNYXN0ZXJEb2NcbiAgICAvLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9jb21tYW5kL2lzTWFzdGVyL1xuICAgIHZhciBmID0gbmV3IEZ1dHVyZTtcbiAgICBzZWxmLl9vcGxvZ0xhc3RFbnRyeUNvbm5lY3Rpb24uZGIuYWRtaW4oKS5jb21tYW5kKFxuICAgICAgeyBpc21hc3RlcjogMSB9LCBmLnJlc29sdmVyKCkpO1xuICAgIHZhciBpc01hc3RlckRvYyA9IGYud2FpdCgpO1xuXG4gICAgaWYgKCEoaXNNYXN0ZXJEb2MgJiYgaXNNYXN0ZXJEb2Muc2V0TmFtZSkpIHtcbiAgICAgIHRocm93IEVycm9yKFwiJE1PTkdPX09QTE9HX1VSTCBtdXN0IGJlIHNldCB0byB0aGUgJ2xvY2FsJyBkYXRhYmFzZSBvZiBcIiArXG4gICAgICAgICAgICAgICAgICBcImEgTW9uZ28gcmVwbGljYSBzZXRcIik7XG4gICAgfVxuXG4gICAgLy8gRmluZCB0aGUgbGFzdCBvcGxvZyBlbnRyeS5cbiAgICB2YXIgbGFzdE9wbG9nRW50cnkgPSBzZWxmLl9vcGxvZ0xhc3RFbnRyeUNvbm5lY3Rpb24uZmluZE9uZShcbiAgICAgIE9QTE9HX0NPTExFQ1RJT04sIHt9LCB7c29ydDogeyRuYXR1cmFsOiAtMX0sIGZpZWxkczoge3RzOiAxfX0pO1xuXG4gICAgdmFyIG9wbG9nU2VsZWN0b3IgPSBfLmNsb25lKHNlbGYuX2Jhc2VPcGxvZ1NlbGVjdG9yKTtcbiAgICBpZiAobGFzdE9wbG9nRW50cnkpIHtcbiAgICAgIC8vIFN0YXJ0IGFmdGVyIHRoZSBsYXN0IGVudHJ5IHRoYXQgY3VycmVudGx5IGV4aXN0cy5cbiAgICAgIG9wbG9nU2VsZWN0b3IudHMgPSB7JGd0OiBsYXN0T3Bsb2dFbnRyeS50c307XG4gICAgICAvLyBJZiB0aGVyZSBhcmUgYW55IGNhbGxzIHRvIGNhbGxXaGVuUHJvY2Vzc2VkTGF0ZXN0IGJlZm9yZSBhbnkgb3RoZXJcbiAgICAgIC8vIG9wbG9nIGVudHJpZXMgc2hvdyB1cCwgYWxsb3cgY2FsbFdoZW5Qcm9jZXNzZWRMYXRlc3QgdG8gY2FsbCBpdHNcbiAgICAgIC8vIGNhbGxiYWNrIGltbWVkaWF0ZWx5LlxuICAgICAgc2VsZi5fbGFzdFByb2Nlc3NlZFRTID0gbGFzdE9wbG9nRW50cnkudHM7XG4gICAgfVxuXG4gICAgdmFyIGN1cnNvckRlc2NyaXB0aW9uID0gbmV3IEN1cnNvckRlc2NyaXB0aW9uKFxuICAgICAgT1BMT0dfQ09MTEVDVElPTiwgb3Bsb2dTZWxlY3Rvciwge3RhaWxhYmxlOiB0cnVlfSk7XG5cbiAgICBzZWxmLl90YWlsSGFuZGxlID0gc2VsZi5fb3Bsb2dUYWlsQ29ubmVjdGlvbi50YWlsKFxuICAgICAgY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uIChkb2MpIHtcbiAgICAgICAgc2VsZi5fZW50cnlRdWV1ZS5wdXNoKGRvYyk7XG4gICAgICAgIHNlbGYuX21heWJlU3RhcnRXb3JrZXIoKTtcbiAgICAgIH1cbiAgICApO1xuICAgIHNlbGYuX3JlYWR5RnV0dXJlLnJldHVybigpO1xuICB9LFxuXG4gIF9tYXliZVN0YXJ0V29ya2VyOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl93b3JrZXJBY3RpdmUpXG4gICAgICByZXR1cm47XG4gICAgc2VsZi5fd29ya2VyQWN0aXZlID0gdHJ1ZTtcbiAgICBNZXRlb3IuZGVmZXIoZnVuY3Rpb24gKCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgd2hpbGUgKCEgc2VsZi5fc3RvcHBlZCAmJiAhIHNlbGYuX2VudHJ5UXVldWUuaXNFbXB0eSgpKSB7XG4gICAgICAgICAgLy8gQXJlIHdlIHRvbyBmYXIgYmVoaW5kPyBKdXN0IHRlbGwgb3VyIG9ic2VydmVycyB0aGF0IHRoZXkgbmVlZCB0b1xuICAgICAgICAgIC8vIHJlcG9sbCwgYW5kIGRyb3Agb3VyIHF1ZXVlLlxuICAgICAgICAgIGlmIChzZWxmLl9lbnRyeVF1ZXVlLmxlbmd0aCA+IFRPT19GQVJfQkVISU5EKSB7XG4gICAgICAgICAgICB2YXIgbGFzdEVudHJ5ID0gc2VsZi5fZW50cnlRdWV1ZS5wb3AoKTtcbiAgICAgICAgICAgIHNlbGYuX2VudHJ5UXVldWUuY2xlYXIoKTtcblxuICAgICAgICAgICAgc2VsZi5fb25Ta2lwcGVkRW50cmllc0hvb2suZWFjaChmdW5jdGlvbiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgLy8gRnJlZSBhbnkgd2FpdFVudGlsQ2F1Z2h0VXAoKSBjYWxscyB0aGF0IHdlcmUgd2FpdGluZyBmb3IgdXMgdG9cbiAgICAgICAgICAgIC8vIHBhc3Mgc29tZXRoaW5nIHRoYXQgd2UganVzdCBza2lwcGVkLlxuICAgICAgICAgICAgc2VsZi5fc2V0TGFzdFByb2Nlc3NlZFRTKGxhc3RFbnRyeS50cyk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICB2YXIgZG9jID0gc2VsZi5fZW50cnlRdWV1ZS5zaGlmdCgpO1xuXG4gICAgICAgICAgaWYgKCEoZG9jLm5zICYmIGRvYy5ucy5sZW5ndGggPiBzZWxmLl9kYk5hbWUubGVuZ3RoICsgMSAmJlxuICAgICAgICAgICAgICAgIGRvYy5ucy5zdWJzdHIoMCwgc2VsZi5fZGJOYW1lLmxlbmd0aCArIDEpID09PVxuICAgICAgICAgICAgICAgIChzZWxmLl9kYk5hbWUgKyAnLicpKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5leHBlY3RlZCBuc1wiKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICB2YXIgdHJpZ2dlciA9IHtjb2xsZWN0aW9uOiBkb2MubnMuc3Vic3RyKHNlbGYuX2RiTmFtZS5sZW5ndGggKyAxKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICBkcm9wQ29sbGVjdGlvbjogZmFsc2UsXG4gICAgICAgICAgICAgICAgICAgICAgICAgZHJvcERhdGFiYXNlOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICBvcDogZG9jfTtcblxuICAgICAgICAgIC8vIElzIGl0IGEgc3BlY2lhbCBjb21tYW5kIGFuZCB0aGUgY29sbGVjdGlvbiBuYW1lIGlzIGhpZGRlbiBzb21ld2hlcmVcbiAgICAgICAgICAvLyBpbiBvcGVyYXRvcj9cbiAgICAgICAgICBpZiAodHJpZ2dlci5jb2xsZWN0aW9uID09PSBcIiRjbWRcIikge1xuICAgICAgICAgICAgaWYgKGRvYy5vLmRyb3BEYXRhYmFzZSkge1xuICAgICAgICAgICAgICBkZWxldGUgdHJpZ2dlci5jb2xsZWN0aW9uO1xuICAgICAgICAgICAgICB0cmlnZ2VyLmRyb3BEYXRhYmFzZSA9IHRydWU7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaGFzKGRvYy5vLCAnZHJvcCcpKSB7XG4gICAgICAgICAgICAgIHRyaWdnZXIuY29sbGVjdGlvbiA9IGRvYy5vLmRyb3A7XG4gICAgICAgICAgICAgIHRyaWdnZXIuZHJvcENvbGxlY3Rpb24gPSB0cnVlO1xuICAgICAgICAgICAgICB0cmlnZ2VyLmlkID0gbnVsbDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHRocm93IEVycm9yKFwiVW5rbm93biBjb21tYW5kIFwiICsgSlNPTi5zdHJpbmdpZnkoZG9jKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIEFsbCBvdGhlciBvcHMgaGF2ZSBhbiBpZC5cbiAgICAgICAgICAgIHRyaWdnZXIuaWQgPSBpZEZvck9wKGRvYyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgc2VsZi5fY3Jvc3NiYXIuZmlyZSh0cmlnZ2VyKTtcblxuICAgICAgICAgIC8vIE5vdyB0aGF0IHdlJ3ZlIHByb2Nlc3NlZCB0aGlzIG9wZXJhdGlvbiwgcHJvY2VzcyBwZW5kaW5nXG4gICAgICAgICAgLy8gc2VxdWVuY2Vycy5cbiAgICAgICAgICBpZiAoIWRvYy50cylcbiAgICAgICAgICAgIHRocm93IEVycm9yKFwib3Bsb2cgZW50cnkgd2l0aG91dCB0czogXCIgKyBFSlNPTi5zdHJpbmdpZnkoZG9jKSk7XG4gICAgICAgICAgc2VsZi5fc2V0TGFzdFByb2Nlc3NlZFRTKGRvYy50cyk7XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHNlbGYuX3dvcmtlckFjdGl2ZSA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICBfc2V0TGFzdFByb2Nlc3NlZFRTOiBmdW5jdGlvbiAodHMpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fbGFzdFByb2Nlc3NlZFRTID0gdHM7XG4gICAgd2hpbGUgKCFfLmlzRW1wdHkoc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMpICYmIHNlbGYuX2NhdGNoaW5nVXBGdXR1cmVzWzBdLnRzLmxlc3NUaGFuT3JFcXVhbChzZWxmLl9sYXN0UHJvY2Vzc2VkVFMpKSB7XG4gICAgICB2YXIgc2VxdWVuY2VyID0gc2VsZi5fY2F0Y2hpbmdVcEZ1dHVyZXMuc2hpZnQoKTtcbiAgICAgIHNlcXVlbmNlci5mdXR1cmUucmV0dXJuKCk7XG4gICAgfVxuICB9LFxuXG4gIC8vTWV0aG9kcyB1c2VkIG9uIHRlc3RzIHRvIGRpbmFtaWNhbGx5IGNoYW5nZSBUT09fRkFSX0JFSElORFxuICBfZGVmaW5lVG9vRmFyQmVoaW5kOiBmdW5jdGlvbih2YWx1ZSkge1xuICAgIFRPT19GQVJfQkVISU5EID0gdmFsdWU7XG4gIH0sXG4gIF9yZXNldFRvb0ZhckJlaGluZDogZnVuY3Rpb24oKSB7XG4gICAgVE9PX0ZBUl9CRUhJTkQgPSBwcm9jZXNzLmVudi5NRVRFT1JfT1BMT0dfVE9PX0ZBUl9CRUhJTkQgfHwgMjAwMDtcbiAgfVxufSk7XG4iLCJ2YXIgRnV0dXJlID0gTnBtLnJlcXVpcmUoJ2ZpYmVycy9mdXR1cmUnKTtcblxuT2JzZXJ2ZU11bHRpcGxleGVyID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gIGlmICghb3B0aW9ucyB8fCAhXy5oYXMob3B0aW9ucywgJ29yZGVyZWQnKSlcbiAgICB0aHJvdyBFcnJvcihcIm11c3Qgc3BlY2lmaWVkIG9yZGVyZWRcIik7XG5cbiAgUGFja2FnZS5mYWN0cyAmJiBQYWNrYWdlLmZhY3RzLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgXCJtb25nby1saXZlZGF0YVwiLCBcIm9ic2VydmUtbXVsdGlwbGV4ZXJzXCIsIDEpO1xuXG4gIHNlbGYuX29yZGVyZWQgPSBvcHRpb25zLm9yZGVyZWQ7XG4gIHNlbGYuX29uU3RvcCA9IG9wdGlvbnMub25TdG9wIHx8IGZ1bmN0aW9uICgpIHt9O1xuICBzZWxmLl9xdWV1ZSA9IG5ldyBNZXRlb3IuX1N5bmNocm9ub3VzUXVldWUoKTtcbiAgc2VsZi5faGFuZGxlcyA9IHt9O1xuICBzZWxmLl9yZWFkeUZ1dHVyZSA9IG5ldyBGdXR1cmU7XG4gIHNlbGYuX2NhY2hlID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fQ2FjaGluZ0NoYW5nZU9ic2VydmVyKHtcbiAgICBvcmRlcmVkOiBvcHRpb25zLm9yZGVyZWR9KTtcbiAgLy8gTnVtYmVyIG9mIGFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkcyB0YXNrcyBzY2hlZHVsZWQgYnV0IG5vdCB5ZXRcbiAgLy8gcnVubmluZy4gcmVtb3ZlSGFuZGxlIHVzZXMgdGhpcyB0byBrbm93IGlmIGl0J3MgdGltZSB0byBjYWxsIHRoZSBvblN0b3BcbiAgLy8gY2FsbGJhY2suXG4gIHNlbGYuX2FkZEhhbmRsZVRhc2tzU2NoZWR1bGVkQnV0Tm90UGVyZm9ybWVkID0gMDtcblxuICBfLmVhY2goc2VsZi5jYWxsYmFja05hbWVzKCksIGZ1bmN0aW9uIChjYWxsYmFja05hbWUpIHtcbiAgICBzZWxmW2NhbGxiYWNrTmFtZV0gPSBmdW5jdGlvbiAoLyogLi4uICovKSB7XG4gICAgICBzZWxmLl9hcHBseUNhbGxiYWNrKGNhbGxiYWNrTmFtZSwgXy50b0FycmF5KGFyZ3VtZW50cykpO1xuICAgIH07XG4gIH0pO1xufTtcblxuXy5leHRlbmQoT2JzZXJ2ZU11bHRpcGxleGVyLnByb3RvdHlwZSwge1xuICBhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHM6IGZ1bmN0aW9uIChoYW5kbGUpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICAvLyBDaGVjayB0aGlzIGJlZm9yZSBjYWxsaW5nIHJ1blRhc2sgKGV2ZW4gdGhvdWdoIHJ1blRhc2sgZG9lcyB0aGUgc2FtZVxuICAgIC8vIGNoZWNrKSBzbyB0aGF0IHdlIGRvbid0IGxlYWsgYW4gT2JzZXJ2ZU11bHRpcGxleGVyIG9uIGVycm9yIGJ5XG4gICAgLy8gaW5jcmVtZW50aW5nIF9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZCBhbmQgbmV2ZXJcbiAgICAvLyBkZWNyZW1lbnRpbmcgaXQuXG4gICAgaWYgKCFzZWxmLl9xdWV1ZS5zYWZlVG9SdW5UYXNrKCkpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4ndCBjYWxsIG9ic2VydmVDaGFuZ2VzIGZyb20gYW4gb2JzZXJ2ZSBjYWxsYmFjayBvbiB0aGUgc2FtZSBxdWVyeVwiKTtcbiAgICArK3NlbGYuX2FkZEhhbmRsZVRhc2tzU2NoZWR1bGVkQnV0Tm90UGVyZm9ybWVkO1xuXG4gICAgUGFja2FnZS5mYWN0cyAmJiBQYWNrYWdlLmZhY3RzLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1oYW5kbGVzXCIsIDEpO1xuXG4gICAgc2VsZi5fcXVldWUucnVuVGFzayhmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9oYW5kbGVzW2hhbmRsZS5faWRdID0gaGFuZGxlO1xuICAgICAgLy8gU2VuZCBvdXQgd2hhdGV2ZXIgYWRkcyB3ZSBoYXZlIHNvIGZhciAod2hldGhlciBvciBub3Qgd2UgdGhlXG4gICAgICAvLyBtdWx0aXBsZXhlciBpcyByZWFkeSkuXG4gICAgICBzZWxmLl9zZW5kQWRkcyhoYW5kbGUpO1xuICAgICAgLS1zZWxmLl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZDtcbiAgICB9KTtcbiAgICAvLyAqb3V0c2lkZSogdGhlIHRhc2ssIHNpbmNlIG90aGVyd2lzZSB3ZSdkIGRlYWRsb2NrXG4gICAgc2VsZi5fcmVhZHlGdXR1cmUud2FpdCgpO1xuICB9LFxuXG4gIC8vIFJlbW92ZSBhbiBvYnNlcnZlIGhhbmRsZS4gSWYgaXQgd2FzIHRoZSBsYXN0IG9ic2VydmUgaGFuZGxlLCBjYWxsIHRoZVxuICAvLyBvblN0b3AgY2FsbGJhY2s7IHlvdSBjYW5ub3QgYWRkIGFueSBtb3JlIG9ic2VydmUgaGFuZGxlcyBhZnRlciB0aGlzLlxuICAvL1xuICAvLyBUaGlzIGlzIG5vdCBzeW5jaHJvbml6ZWQgd2l0aCBwb2xscyBhbmQgaGFuZGxlIGFkZGl0aW9uczogdGhpcyBtZWFucyB0aGF0XG4gIC8vIHlvdSBjYW4gc2FmZWx5IGNhbGwgaXQgZnJvbSB3aXRoaW4gYW4gb2JzZXJ2ZSBjYWxsYmFjaywgYnV0IGl0IGFsc28gbWVhbnNcbiAgLy8gdGhhdCB3ZSBoYXZlIHRvIGJlIGNhcmVmdWwgd2hlbiB3ZSBpdGVyYXRlIG92ZXIgX2hhbmRsZXMuXG4gIHJlbW92ZUhhbmRsZTogZnVuY3Rpb24gKGlkKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuXG4gICAgLy8gVGhpcyBzaG91bGQgbm90IGJlIHBvc3NpYmxlOiB5b3UgY2FuIG9ubHkgY2FsbCByZW1vdmVIYW5kbGUgYnkgaGF2aW5nXG4gICAgLy8gYWNjZXNzIHRvIHRoZSBPYnNlcnZlSGFuZGxlLCB3aGljaCBpc24ndCByZXR1cm5lZCB0byB1c2VyIGNvZGUgdW50aWwgdGhlXG4gICAgLy8gbXVsdGlwbGV4IGlzIHJlYWR5LlxuICAgIGlmICghc2VsZi5fcmVhZHkoKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbid0IHJlbW92ZSBoYW5kbGVzIHVudGlsIHRoZSBtdWx0aXBsZXggaXMgcmVhZHlcIik7XG5cbiAgICBkZWxldGUgc2VsZi5faGFuZGxlc1tpZF07XG5cbiAgICBQYWNrYWdlLmZhY3RzICYmIFBhY2thZ2UuZmFjdHMuRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWhhbmRsZXNcIiwgLTEpO1xuXG4gICAgaWYgKF8uaXNFbXB0eShzZWxmLl9oYW5kbGVzKSAmJlxuICAgICAgICBzZWxmLl9hZGRIYW5kbGVUYXNrc1NjaGVkdWxlZEJ1dE5vdFBlcmZvcm1lZCA9PT0gMCkge1xuICAgICAgc2VsZi5fc3RvcCgpO1xuICAgIH1cbiAgfSxcbiAgX3N0b3A6IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuXG4gICAgLy8gSXQgc2hvdWxkbid0IGJlIHBvc3NpYmxlIGZvciB1cyB0byBzdG9wIHdoZW4gYWxsIG91ciBoYW5kbGVzIHN0aWxsXG4gICAgLy8gaGF2ZW4ndCBiZWVuIHJldHVybmVkIGZyb20gb2JzZXJ2ZUNoYW5nZXMhXG4gICAgaWYgKCEgc2VsZi5fcmVhZHkoKSAmJiAhIG9wdGlvbnMuZnJvbVF1ZXJ5RXJyb3IpXG4gICAgICB0aHJvdyBFcnJvcihcInN1cnByaXNpbmcgX3N0b3A6IG5vdCByZWFkeVwiKTtcblxuICAgIC8vIENhbGwgc3RvcCBjYWxsYmFjayAod2hpY2gga2lsbHMgdGhlIHVuZGVybHlpbmcgcHJvY2VzcyB3aGljaCBzZW5kcyB1c1xuICAgIC8vIGNhbGxiYWNrcyBhbmQgcmVtb3ZlcyB1cyBmcm9tIHRoZSBjb25uZWN0aW9uJ3MgZGljdGlvbmFyeSkuXG4gICAgc2VsZi5fb25TdG9wKCk7XG4gICAgUGFja2FnZS5mYWN0cyAmJiBQYWNrYWdlLmZhY3RzLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICBcIm1vbmdvLWxpdmVkYXRhXCIsIFwib2JzZXJ2ZS1tdWx0aXBsZXhlcnNcIiwgLTEpO1xuXG4gICAgLy8gQ2F1c2UgZnV0dXJlIGFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkcyBjYWxscyB0byB0aHJvdyAoYnV0IHRoZSBvblN0b3BcbiAgICAvLyBjYWxsYmFjayBzaG91bGQgbWFrZSBvdXIgY29ubmVjdGlvbiBmb3JnZXQgYWJvdXQgdXMpLlxuICAgIHNlbGYuX2hhbmRsZXMgPSBudWxsO1xuICB9LFxuXG4gIC8vIEFsbG93cyBhbGwgYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzIGNhbGxzIHRvIHJldHVybiwgb25jZSBhbGwgcHJlY2VkaW5nXG4gIC8vIGFkZHMgaGF2ZSBiZWVuIHByb2Nlc3NlZC4gRG9lcyBub3QgYmxvY2suXG4gIHJlYWR5OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX3F1ZXVlLnF1ZXVlVGFzayhmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoc2VsZi5fcmVhZHkoKSlcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJjYW4ndCBtYWtlIE9ic2VydmVNdWx0aXBsZXggcmVhZHkgdHdpY2UhXCIpO1xuICAgICAgc2VsZi5fcmVhZHlGdXR1cmUucmV0dXJuKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gSWYgdHJ5aW5nIHRvIGV4ZWN1dGUgdGhlIHF1ZXJ5IHJlc3VsdHMgaW4gYW4gZXJyb3IsIGNhbGwgdGhpcy4gVGhpcyBpc1xuICAvLyBpbnRlbmRlZCBmb3IgcGVybWFuZW50IGVycm9ycywgbm90IHRyYW5zaWVudCBuZXR3b3JrIGVycm9ycyB0aGF0IGNvdWxkIGJlXG4gIC8vIGZpeGVkLiBJdCBzaG91bGQgb25seSBiZSBjYWxsZWQgYmVmb3JlIHJlYWR5KCksIGJlY2F1c2UgaWYgeW91IGNhbGxlZCByZWFkeVxuICAvLyB0aGF0IG1lYW50IHRoYXQgeW91IG1hbmFnZWQgdG8gcnVuIHRoZSBxdWVyeSBvbmNlLiBJdCB3aWxsIHN0b3AgdGhpc1xuICAvLyBPYnNlcnZlTXVsdGlwbGV4IGFuZCBjYXVzZSBhZGRIYW5kbGVBbmRTZW5kSW5pdGlhbEFkZHMgY2FsbHMgKGFuZCB0aHVzXG4gIC8vIG9ic2VydmVDaGFuZ2VzIGNhbGxzKSB0byB0aHJvdyB0aGUgZXJyb3IuXG4gIHF1ZXJ5RXJyb3I6IGZ1bmN0aW9uIChlcnIpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgc2VsZi5fcXVldWUucnVuVGFzayhmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoc2VsZi5fcmVhZHkoKSlcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJjYW4ndCBjbGFpbSBxdWVyeSBoYXMgYW4gZXJyb3IgYWZ0ZXIgaXQgd29ya2VkIVwiKTtcbiAgICAgIHNlbGYuX3N0b3Aoe2Zyb21RdWVyeUVycm9yOiB0cnVlfSk7XG4gICAgICBzZWxmLl9yZWFkeUZ1dHVyZS50aHJvdyhlcnIpO1xuICAgIH0pO1xuICB9LFxuXG4gIC8vIENhbGxzIFwiY2JcIiBvbmNlIHRoZSBlZmZlY3RzIG9mIGFsbCBcInJlYWR5XCIsIFwiYWRkSGFuZGxlQW5kU2VuZEluaXRpYWxBZGRzXCJcbiAgLy8gYW5kIG9ic2VydmUgY2FsbGJhY2tzIHdoaWNoIGNhbWUgYmVmb3JlIHRoaXMgY2FsbCBoYXZlIGJlZW4gcHJvcGFnYXRlZCB0b1xuICAvLyBhbGwgaGFuZGxlcy4gXCJyZWFkeVwiIG11c3QgaGF2ZSBhbHJlYWR5IGJlZW4gY2FsbGVkIG9uIHRoaXMgbXVsdGlwbGV4ZXIuXG4gIG9uRmx1c2g6IGZ1bmN0aW9uIChjYikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBzZWxmLl9xdWV1ZS5xdWV1ZVRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKCFzZWxmLl9yZWFkeSgpKVxuICAgICAgICB0aHJvdyBFcnJvcihcIm9ubHkgY2FsbCBvbkZsdXNoIG9uIGEgbXVsdGlwbGV4ZXIgdGhhdCB3aWxsIGJlIHJlYWR5XCIpO1xuICAgICAgY2IoKTtcbiAgICB9KTtcbiAgfSxcbiAgY2FsbGJhY2tOYW1lczogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoc2VsZi5fb3JkZXJlZClcbiAgICAgIHJldHVybiBbXCJhZGRlZEJlZm9yZVwiLCBcImNoYW5nZWRcIiwgXCJtb3ZlZEJlZm9yZVwiLCBcInJlbW92ZWRcIl07XG4gICAgZWxzZVxuICAgICAgcmV0dXJuIFtcImFkZGVkXCIsIFwiY2hhbmdlZFwiLCBcInJlbW92ZWRcIl07XG4gIH0sXG4gIF9yZWFkeTogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzLl9yZWFkeUZ1dHVyZS5pc1Jlc29sdmVkKCk7XG4gIH0sXG4gIF9hcHBseUNhbGxiYWNrOiBmdW5jdGlvbiAoY2FsbGJhY2tOYW1lLCBhcmdzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX3F1ZXVlLnF1ZXVlVGFzayhmdW5jdGlvbiAoKSB7XG4gICAgICAvLyBJZiB3ZSBzdG9wcGVkIGluIHRoZSBtZWFudGltZSwgZG8gbm90aGluZy5cbiAgICAgIGlmICghc2VsZi5faGFuZGxlcylcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAvLyBGaXJzdCwgYXBwbHkgdGhlIGNoYW5nZSB0byB0aGUgY2FjaGUuXG4gICAgICAvLyBYWFggV2UgY291bGQgbWFrZSBhcHBseUNoYW5nZSBjYWxsYmFja3MgcHJvbWlzZSBub3QgdG8gaGFuZyBvbiB0byBhbnlcbiAgICAgIC8vIHN0YXRlIGZyb20gdGhlaXIgYXJndW1lbnRzIChhc3N1bWluZyB0aGF0IHRoZWlyIHN1cHBsaWVkIGNhbGxiYWNrc1xuICAgICAgLy8gZG9uJ3QpIGFuZCBza2lwIHRoaXMgY2xvbmUuIEN1cnJlbnRseSAnY2hhbmdlZCcgaGFuZ3Mgb24gdG8gc3RhdGVcbiAgICAgIC8vIHRob3VnaC5cbiAgICAgIHNlbGYuX2NhY2hlLmFwcGx5Q2hhbmdlW2NhbGxiYWNrTmFtZV0uYXBwbHkobnVsbCwgRUpTT04uY2xvbmUoYXJncykpO1xuXG4gICAgICAvLyBJZiB3ZSBoYXZlbid0IGZpbmlzaGVkIHRoZSBpbml0aWFsIGFkZHMsIHRoZW4gd2Ugc2hvdWxkIG9ubHkgYmUgZ2V0dGluZ1xuICAgICAgLy8gYWRkcy5cbiAgICAgIGlmICghc2VsZi5fcmVhZHkoKSAmJlxuICAgICAgICAgIChjYWxsYmFja05hbWUgIT09ICdhZGRlZCcgJiYgY2FsbGJhY2tOYW1lICE9PSAnYWRkZWRCZWZvcmUnKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHb3QgXCIgKyBjYWxsYmFja05hbWUgKyBcIiBkdXJpbmcgaW5pdGlhbCBhZGRzXCIpO1xuICAgICAgfVxuXG4gICAgICAvLyBOb3cgbXVsdGlwbGV4IHRoZSBjYWxsYmFja3Mgb3V0IHRvIGFsbCBvYnNlcnZlIGhhbmRsZXMuIEl0J3MgT0sgaWZcbiAgICAgIC8vIHRoZXNlIGNhbGxzIHlpZWxkOyBzaW5jZSB3ZSdyZSBpbnNpZGUgYSB0YXNrLCBubyBvdGhlciB1c2Ugb2Ygb3VyIHF1ZXVlXG4gICAgICAvLyBjYW4gY29udGludWUgdW50aWwgdGhlc2UgYXJlIGRvbmUuIChCdXQgd2UgZG8gaGF2ZSB0byBiZSBjYXJlZnVsIHRvIG5vdFxuICAgICAgLy8gdXNlIGEgaGFuZGxlIHRoYXQgZ290IHJlbW92ZWQsIGJlY2F1c2UgcmVtb3ZlSGFuZGxlIGRvZXMgbm90IHVzZSB0aGVcbiAgICAgIC8vIHF1ZXVlOyB0aHVzLCB3ZSBpdGVyYXRlIG92ZXIgYW4gYXJyYXkgb2Yga2V5cyB0aGF0IHdlIGNvbnRyb2wuKVxuICAgICAgXy5lYWNoKF8ua2V5cyhzZWxmLl9oYW5kbGVzKSwgZnVuY3Rpb24gKGhhbmRsZUlkKSB7XG4gICAgICAgIHZhciBoYW5kbGUgPSBzZWxmLl9oYW5kbGVzICYmIHNlbGYuX2hhbmRsZXNbaGFuZGxlSWRdO1xuICAgICAgICBpZiAoIWhhbmRsZSlcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIHZhciBjYWxsYmFjayA9IGhhbmRsZVsnXycgKyBjYWxsYmFja05hbWVdO1xuICAgICAgICAvLyBjbG9uZSBhcmd1bWVudHMgc28gdGhhdCBjYWxsYmFja3MgY2FuIG11dGF0ZSB0aGVpciBhcmd1bWVudHNcbiAgICAgICAgY2FsbGJhY2sgJiYgY2FsbGJhY2suYXBwbHkobnVsbCwgRUpTT04uY2xvbmUoYXJncykpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gU2VuZHMgaW5pdGlhbCBhZGRzIHRvIGEgaGFuZGxlLiBJdCBzaG91bGQgb25seSBiZSBjYWxsZWQgZnJvbSB3aXRoaW4gYSB0YXNrXG4gIC8vICh0aGUgdGFzayB0aGF0IGlzIHByb2Nlc3NpbmcgdGhlIGFkZEhhbmRsZUFuZFNlbmRJbml0aWFsQWRkcyBjYWxsKS4gSXRcbiAgLy8gc3luY2hyb25vdXNseSBpbnZva2VzIHRoZSBoYW5kbGUncyBhZGRlZCBvciBhZGRlZEJlZm9yZTsgdGhlcmUncyBubyBuZWVkIHRvXG4gIC8vIGZsdXNoIHRoZSBxdWV1ZSBhZnRlcndhcmRzIHRvIGVuc3VyZSB0aGF0IHRoZSBjYWxsYmFja3MgZ2V0IG91dC5cbiAgX3NlbmRBZGRzOiBmdW5jdGlvbiAoaGFuZGxlKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9xdWV1ZS5zYWZlVG9SdW5UYXNrKCkpXG4gICAgICB0aHJvdyBFcnJvcihcIl9zZW5kQWRkcyBtYXkgb25seSBiZSBjYWxsZWQgZnJvbSB3aXRoaW4gYSB0YXNrIVwiKTtcbiAgICB2YXIgYWRkID0gc2VsZi5fb3JkZXJlZCA/IGhhbmRsZS5fYWRkZWRCZWZvcmUgOiBoYW5kbGUuX2FkZGVkO1xuICAgIGlmICghYWRkKVxuICAgICAgcmV0dXJuO1xuICAgIC8vIG5vdGU6IGRvY3MgbWF5IGJlIGFuIF9JZE1hcCBvciBhbiBPcmRlcmVkRGljdFxuICAgIHNlbGYuX2NhY2hlLmRvY3MuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpZCkge1xuICAgICAgaWYgKCFfLmhhcyhzZWxmLl9oYW5kbGVzLCBoYW5kbGUuX2lkKSlcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJoYW5kbGUgZ290IHJlbW92ZWQgYmVmb3JlIHNlbmRpbmcgaW5pdGlhbCBhZGRzIVwiKTtcbiAgICAgIHZhciBmaWVsZHMgPSBFSlNPTi5jbG9uZShkb2MpO1xuICAgICAgZGVsZXRlIGZpZWxkcy5faWQ7XG4gICAgICBpZiAoc2VsZi5fb3JkZXJlZClcbiAgICAgICAgYWRkKGlkLCBmaWVsZHMsIG51bGwpOyAvLyB3ZSdyZSBnb2luZyBpbiBvcmRlciwgc28gYWRkIGF0IGVuZFxuICAgICAgZWxzZVxuICAgICAgICBhZGQoaWQsIGZpZWxkcyk7XG4gICAgfSk7XG4gIH1cbn0pO1xuXG5cbnZhciBuZXh0T2JzZXJ2ZUhhbmRsZUlkID0gMTtcbk9ic2VydmVIYW5kbGUgPSBmdW5jdGlvbiAobXVsdGlwbGV4ZXIsIGNhbGxiYWNrcykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIC8vIFRoZSBlbmQgdXNlciBpcyBvbmx5IHN1cHBvc2VkIHRvIGNhbGwgc3RvcCgpLiAgVGhlIG90aGVyIGZpZWxkcyBhcmVcbiAgLy8gYWNjZXNzaWJsZSB0byB0aGUgbXVsdGlwbGV4ZXIsIHRob3VnaC5cbiAgc2VsZi5fbXVsdGlwbGV4ZXIgPSBtdWx0aXBsZXhlcjtcbiAgXy5lYWNoKG11bHRpcGxleGVyLmNhbGxiYWNrTmFtZXMoKSwgZnVuY3Rpb24gKG5hbWUpIHtcbiAgICBpZiAoY2FsbGJhY2tzW25hbWVdKSB7XG4gICAgICBzZWxmWydfJyArIG5hbWVdID0gY2FsbGJhY2tzW25hbWVdO1xuICAgIH0gZWxzZSBpZiAobmFtZSA9PT0gXCJhZGRlZEJlZm9yZVwiICYmIGNhbGxiYWNrcy5hZGRlZCkge1xuICAgICAgLy8gU3BlY2lhbCBjYXNlOiBpZiB5b3Ugc3BlY2lmeSBcImFkZGVkXCIgYW5kIFwibW92ZWRCZWZvcmVcIiwgeW91IGdldCBhblxuICAgICAgLy8gb3JkZXJlZCBvYnNlcnZlIHdoZXJlIGZvciBzb21lIHJlYXNvbiB5b3UgZG9uJ3QgZ2V0IG9yZGVyaW5nIGRhdGEgb25cbiAgICAgIC8vIHRoZSBhZGRzLiAgSSBkdW5ubywgd2Ugd3JvdGUgdGVzdHMgZm9yIGl0LCB0aGVyZSBtdXN0IGhhdmUgYmVlbiBhXG4gICAgICAvLyByZWFzb24uXG4gICAgICBzZWxmLl9hZGRlZEJlZm9yZSA9IGZ1bmN0aW9uIChpZCwgZmllbGRzLCBiZWZvcmUpIHtcbiAgICAgICAgY2FsbGJhY2tzLmFkZGVkKGlkLCBmaWVsZHMpO1xuICAgICAgfTtcbiAgICB9XG4gIH0pO1xuICBzZWxmLl9zdG9wcGVkID0gZmFsc2U7XG4gIHNlbGYuX2lkID0gbmV4dE9ic2VydmVIYW5kbGVJZCsrO1xufTtcbk9ic2VydmVIYW5kbGUucHJvdG90eXBlLnN0b3AgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgcmV0dXJuO1xuICBzZWxmLl9zdG9wcGVkID0gdHJ1ZTtcbiAgc2VsZi5fbXVsdGlwbGV4ZXIucmVtb3ZlSGFuZGxlKHNlbGYuX2lkKTtcbn07XG4iLCJ2YXIgRmliZXIgPSBOcG0ucmVxdWlyZSgnZmliZXJzJyk7XG52YXIgRnV0dXJlID0gTnBtLnJlcXVpcmUoJ2ZpYmVycy9mdXR1cmUnKTtcblxuRG9jRmV0Y2hlciA9IGZ1bmN0aW9uIChtb25nb0Nvbm5lY3Rpb24pIHtcbiAgdmFyIHNlbGYgPSB0aGlzO1xuICBzZWxmLl9tb25nb0Nvbm5lY3Rpb24gPSBtb25nb0Nvbm5lY3Rpb247XG4gIC8vIE1hcCBmcm9tIGNhY2hlIGtleSAtPiBbY2FsbGJhY2tdXG4gIHNlbGYuX2NhbGxiYWNrc0ZvckNhY2hlS2V5ID0ge307XG59O1xuXG5fLmV4dGVuZChEb2NGZXRjaGVyLnByb3RvdHlwZSwge1xuICAvLyBGZXRjaGVzIGRvY3VtZW50IFwiaWRcIiBmcm9tIGNvbGxlY3Rpb25OYW1lLCByZXR1cm5pbmcgaXQgb3IgbnVsbCBpZiBub3RcbiAgLy8gZm91bmQuXG4gIC8vXG4gIC8vIElmIHlvdSBtYWtlIG11bHRpcGxlIGNhbGxzIHRvIGZldGNoKCkgd2l0aCB0aGUgc2FtZSBjYWNoZUtleSAoYSBzdHJpbmcpLFxuICAvLyBEb2NGZXRjaGVyIG1heSBhc3N1bWUgdGhhdCB0aGV5IGFsbCByZXR1cm4gdGhlIHNhbWUgZG9jdW1lbnQuIChJdCBkb2VzXG4gIC8vIG5vdCBjaGVjayB0byBzZWUgaWYgY29sbGVjdGlvbk5hbWUvaWQgbWF0Y2guKVxuICAvL1xuICAvLyBZb3UgbWF5IGFzc3VtZSB0aGF0IGNhbGxiYWNrIGlzIG5ldmVyIGNhbGxlZCBzeW5jaHJvbm91c2x5IChhbmQgaW4gZmFjdFxuICAvLyBPcGxvZ09ic2VydmVEcml2ZXIgZG9lcyBzbykuXG4gIGZldGNoOiBmdW5jdGlvbiAoY29sbGVjdGlvbk5hbWUsIGlkLCBjYWNoZUtleSwgY2FsbGJhY2spIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICBjaGVjayhjb2xsZWN0aW9uTmFtZSwgU3RyaW5nKTtcbiAgICAvLyBpZCBpcyBzb21lIHNvcnQgb2Ygc2NhbGFyXG4gICAgY2hlY2soY2FjaGVLZXksIFN0cmluZyk7XG5cbiAgICAvLyBJZiB0aGVyZSdzIGFscmVhZHkgYW4gaW4tcHJvZ3Jlc3MgZmV0Y2ggZm9yIHRoaXMgY2FjaGUga2V5LCB5aWVsZCB1bnRpbFxuICAgIC8vIGl0J3MgZG9uZSBhbmQgcmV0dXJuIHdoYXRldmVyIGl0IHJldHVybnMuXG4gICAgaWYgKF8uaGFzKHNlbGYuX2NhbGxiYWNrc0ZvckNhY2hlS2V5LCBjYWNoZUtleSkpIHtcbiAgICAgIHNlbGYuX2NhbGxiYWNrc0ZvckNhY2hlS2V5W2NhY2hlS2V5XS5wdXNoKGNhbGxiYWNrKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB2YXIgY2FsbGJhY2tzID0gc2VsZi5fY2FsbGJhY2tzRm9yQ2FjaGVLZXlbY2FjaGVLZXldID0gW2NhbGxiYWNrXTtcblxuICAgIEZpYmVyKGZ1bmN0aW9uICgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHZhciBkb2MgPSBzZWxmLl9tb25nb0Nvbm5lY3Rpb24uZmluZE9uZShcbiAgICAgICAgICBjb2xsZWN0aW9uTmFtZSwge19pZDogaWR9KSB8fCBudWxsO1xuICAgICAgICAvLyBSZXR1cm4gZG9jIHRvIGFsbCByZWxldmFudCBjYWxsYmFja3MuIE5vdGUgdGhhdCB0aGlzIGFycmF5IGNhblxuICAgICAgICAvLyBjb250aW51ZSB0byBncm93IGR1cmluZyBjYWxsYmFjayBleGNlY3V0aW9uLlxuICAgICAgICB3aGlsZSAoIV8uaXNFbXB0eShjYWxsYmFja3MpKSB7XG4gICAgICAgICAgLy8gQ2xvbmUgdGhlIGRvY3VtZW50IHNvIHRoYXQgdGhlIHZhcmlvdXMgY2FsbHMgdG8gZmV0Y2ggZG9uJ3QgcmV0dXJuXG4gICAgICAgICAgLy8gb2JqZWN0cyB0aGF0IGFyZSBpbnRlcnR3aW5nbGVkIHdpdGggZWFjaCBvdGhlci4gQ2xvbmUgYmVmb3JlXG4gICAgICAgICAgLy8gcG9wcGluZyB0aGUgZnV0dXJlLCBzbyB0aGF0IGlmIGNsb25lIHRocm93cywgdGhlIGVycm9yIGdldHMgcGFzc2VkXG4gICAgICAgICAgLy8gdG8gdGhlIG5leHQgY2FsbGJhY2suXG4gICAgICAgICAgdmFyIGNsb25lZERvYyA9IEVKU09OLmNsb25lKGRvYyk7XG4gICAgICAgICAgY2FsbGJhY2tzLnBvcCgpKG51bGwsIGNsb25lZERvYyk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgd2hpbGUgKCFfLmlzRW1wdHkoY2FsbGJhY2tzKSkge1xuICAgICAgICAgIGNhbGxiYWNrcy5wb3AoKShlKTtcbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgLy8gWFhYIGNvbnNpZGVyIGtlZXBpbmcgdGhlIGRvYyBhcm91bmQgZm9yIGEgcGVyaW9kIG9mIHRpbWUgYmVmb3JlXG4gICAgICAgIC8vIHJlbW92aW5nIGZyb20gdGhlIGNhY2hlXG4gICAgICAgIGRlbGV0ZSBzZWxmLl9jYWxsYmFja3NGb3JDYWNoZUtleVtjYWNoZUtleV07XG4gICAgICB9XG4gICAgfSkucnVuKCk7XG4gIH1cbn0pO1xuXG5Nb25nb1Rlc3QuRG9jRmV0Y2hlciA9IERvY0ZldGNoZXI7XG4iLCJQb2xsaW5nT2JzZXJ2ZURyaXZlciA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcblxuICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiA9IG9wdGlvbnMuY3Vyc29yRGVzY3JpcHRpb247XG4gIHNlbGYuX21vbmdvSGFuZGxlID0gb3B0aW9ucy5tb25nb0hhbmRsZTtcbiAgc2VsZi5fb3JkZXJlZCA9IG9wdGlvbnMub3JkZXJlZDtcbiAgc2VsZi5fbXVsdGlwbGV4ZXIgPSBvcHRpb25zLm11bHRpcGxleGVyO1xuICBzZWxmLl9zdG9wQ2FsbGJhY2tzID0gW107XG4gIHNlbGYuX3N0b3BwZWQgPSBmYWxzZTtcblxuICBzZWxmLl9zeW5jaHJvbm91c0N1cnNvciA9IHNlbGYuX21vbmdvSGFuZGxlLl9jcmVhdGVTeW5jaHJvbm91c0N1cnNvcihcbiAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbik7XG5cbiAgLy8gcHJldmlvdXMgcmVzdWx0cyBzbmFwc2hvdC4gIG9uIGVhY2ggcG9sbCBjeWNsZSwgZGlmZnMgYWdhaW5zdFxuICAvLyByZXN1bHRzIGRyaXZlcyB0aGUgY2FsbGJhY2tzLlxuICBzZWxmLl9yZXN1bHRzID0gbnVsbDtcblxuICAvLyBUaGUgbnVtYmVyIG9mIF9wb2xsTW9uZ28gY2FsbHMgdGhhdCBoYXZlIGJlZW4gYWRkZWQgdG8gc2VsZi5fdGFza1F1ZXVlIGJ1dFxuICAvLyBoYXZlIG5vdCBzdGFydGVkIHJ1bm5pbmcuIFVzZWQgdG8gbWFrZSBzdXJlIHdlIG5ldmVyIHNjaGVkdWxlIG1vcmUgdGhhbiBvbmVcbiAgLy8gX3BvbGxNb25nbyAob3RoZXIgdGhhbiBwb3NzaWJseSB0aGUgb25lIHRoYXQgaXMgY3VycmVudGx5IHJ1bm5pbmcpLiBJdCdzXG4gIC8vIGFsc28gdXNlZCBieSBfc3VzcGVuZFBvbGxpbmcgdG8gcHJldGVuZCB0aGVyZSdzIGEgcG9sbCBzY2hlZHVsZWQuIFVzdWFsbHksXG4gIC8vIGl0J3MgZWl0aGVyIDAgKGZvciBcIm5vIHBvbGxzIHNjaGVkdWxlZCBvdGhlciB0aGFuIG1heWJlIG9uZSBjdXJyZW50bHlcbiAgLy8gcnVubmluZ1wiKSBvciAxIChmb3IgXCJhIHBvbGwgc2NoZWR1bGVkIHRoYXQgaXNuJ3QgcnVubmluZyB5ZXRcIiksIGJ1dCBpdCBjYW5cbiAgLy8gYWxzbyBiZSAyIGlmIGluY3JlbWVudGVkIGJ5IF9zdXNwZW5kUG9sbGluZy5cbiAgc2VsZi5fcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkID0gMDtcbiAgc2VsZi5fcGVuZGluZ1dyaXRlcyA9IFtdOyAvLyBwZW9wbGUgdG8gbm90aWZ5IHdoZW4gcG9sbGluZyBjb21wbGV0ZXNcblxuICAvLyBNYWtlIHN1cmUgdG8gY3JlYXRlIGEgc2VwYXJhdGVseSB0aHJvdHRsZWQgZnVuY3Rpb24gZm9yIGVhY2hcbiAgLy8gUG9sbGluZ09ic2VydmVEcml2ZXIgb2JqZWN0LlxuICBzZWxmLl9lbnN1cmVQb2xsSXNTY2hlZHVsZWQgPSBfLnRocm90dGxlKFxuICAgIHNlbGYuX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkLFxuICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMucG9sbGluZ1Rocm90dGxlTXMgfHwgNTAgLyogbXMgKi8pO1xuXG4gIC8vIFhYWCBmaWd1cmUgb3V0IGlmIHdlIHN0aWxsIG5lZWQgYSBxdWV1ZVxuICBzZWxmLl90YXNrUXVldWUgPSBuZXcgTWV0ZW9yLl9TeW5jaHJvbm91c1F1ZXVlKCk7XG5cbiAgdmFyIGxpc3RlbmVyc0hhbmRsZSA9IGxpc3RlbkFsbChcbiAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiwgZnVuY3Rpb24gKG5vdGlmaWNhdGlvbikge1xuICAgICAgLy8gV2hlbiBzb21lb25lIGRvZXMgYSB0cmFuc2FjdGlvbiB0aGF0IG1pZ2h0IGFmZmVjdCB1cywgc2NoZWR1bGUgYSBwb2xsXG4gICAgICAvLyBvZiB0aGUgZGF0YWJhc2UuIElmIHRoYXQgdHJhbnNhY3Rpb24gaGFwcGVucyBpbnNpZGUgb2YgYSB3cml0ZSBmZW5jZSxcbiAgICAgIC8vIGJsb2NrIHRoZSBmZW5jZSB1bnRpbCB3ZSd2ZSBwb2xsZWQgYW5kIG5vdGlmaWVkIG9ic2VydmVycy5cbiAgICAgIHZhciBmZW5jZSA9IEREUFNlcnZlci5fQ3VycmVudFdyaXRlRmVuY2UuZ2V0KCk7XG4gICAgICBpZiAoZmVuY2UpXG4gICAgICAgIHNlbGYuX3BlbmRpbmdXcml0ZXMucHVzaChmZW5jZS5iZWdpbldyaXRlKCkpO1xuICAgICAgLy8gRW5zdXJlIGEgcG9sbCBpcyBzY2hlZHVsZWQuLi4gYnV0IGlmIHdlIGFscmVhZHkga25vdyB0aGF0IG9uZSBpcyxcbiAgICAgIC8vIGRvbid0IGhpdCB0aGUgdGhyb3R0bGVkIF9lbnN1cmVQb2xsSXNTY2hlZHVsZWQgZnVuY3Rpb24gKHdoaWNoIG1pZ2h0XG4gICAgICAvLyBsZWFkIHRvIHVzIGNhbGxpbmcgaXQgdW5uZWNlc3NhcmlseSBpbiA8cG9sbGluZ1Rocm90dGxlTXM+IG1zKS5cbiAgICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgPT09IDApXG4gICAgICAgIHNlbGYuX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCgpO1xuICAgIH1cbiAgKTtcbiAgc2VsZi5fc3RvcENhbGxiYWNrcy5wdXNoKGZ1bmN0aW9uICgpIHsgbGlzdGVuZXJzSGFuZGxlLnN0b3AoKTsgfSk7XG5cbiAgLy8gZXZlcnkgb25jZSBhbmQgYSB3aGlsZSwgcG9sbCBldmVuIGlmIHdlIGRvbid0IHRoaW5rIHdlJ3JlIGRpcnR5LCBmb3JcbiAgLy8gZXZlbnR1YWwgY29uc2lzdGVuY3kgd2l0aCBkYXRhYmFzZSB3cml0ZXMgZnJvbSBvdXRzaWRlIHRoZSBNZXRlb3JcbiAgLy8gdW5pdmVyc2UuXG4gIC8vXG4gIC8vIEZvciB0ZXN0aW5nLCB0aGVyZSdzIGFuIHVuZG9jdW1lbnRlZCBjYWxsYmFjayBhcmd1bWVudCB0byBvYnNlcnZlQ2hhbmdlc1xuICAvLyB3aGljaCBkaXNhYmxlcyB0aW1lLWJhc2VkIHBvbGxpbmcgYW5kIGdldHMgY2FsbGVkIGF0IHRoZSBiZWdpbm5pbmcgb2YgZWFjaFxuICAvLyBwb2xsLlxuICBpZiAob3B0aW9ucy5fdGVzdE9ubHlQb2xsQ2FsbGJhY2spIHtcbiAgICBzZWxmLl90ZXN0T25seVBvbGxDYWxsYmFjayA9IG9wdGlvbnMuX3Rlc3RPbmx5UG9sbENhbGxiYWNrO1xuICB9IGVsc2Uge1xuICAgIHZhciBwb2xsaW5nSW50ZXJ2YWwgPVxuICAgICAgICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMucG9sbGluZ0ludGVydmFsTXMgfHxcbiAgICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5vcHRpb25zLl9wb2xsaW5nSW50ZXJ2YWwgfHwgLy8gQ09NUEFUIHdpdGggMS4yXG4gICAgICAgICAgMTAgKiAxMDAwO1xuICAgIHZhciBpbnRlcnZhbEhhbmRsZSA9IE1ldGVvci5zZXRJbnRlcnZhbChcbiAgICAgIF8uYmluZChzZWxmLl9lbnN1cmVQb2xsSXNTY2hlZHVsZWQsIHNlbGYpLCBwb2xsaW5nSW50ZXJ2YWwpO1xuICAgIHNlbGYuX3N0b3BDYWxsYmFja3MucHVzaChmdW5jdGlvbiAoKSB7XG4gICAgICBNZXRlb3IuY2xlYXJJbnRlcnZhbChpbnRlcnZhbEhhbmRsZSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBNYWtlIHN1cmUgd2UgYWN0dWFsbHkgcG9sbCBzb29uIVxuICBzZWxmLl91bnRocm90dGxlZEVuc3VyZVBvbGxJc1NjaGVkdWxlZCgpO1xuXG4gIFBhY2thZ2UuZmFjdHMgJiYgUGFja2FnZS5mYWN0cy5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtcG9sbGluZ1wiLCAxKTtcbn07XG5cbl8uZXh0ZW5kKFBvbGxpbmdPYnNlcnZlRHJpdmVyLnByb3RvdHlwZSwge1xuICAvLyBUaGlzIGlzIGFsd2F5cyBjYWxsZWQgdGhyb3VnaCBfLnRocm90dGxlIChleGNlcHQgb25jZSBhdCBzdGFydHVwKS5cbiAgX3VudGhyb3R0bGVkRW5zdXJlUG9sbElzU2NoZWR1bGVkOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgPiAwKVxuICAgICAgcmV0dXJuO1xuICAgICsrc2VsZi5fcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkO1xuICAgIHNlbGYuX3Rhc2tRdWV1ZS5xdWV1ZVRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcG9sbE1vbmdvKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gdGVzdC1vbmx5IGludGVyZmFjZSBmb3IgY29udHJvbGxpbmcgcG9sbGluZy5cbiAgLy9cbiAgLy8gX3N1c3BlbmRQb2xsaW5nIGJsb2NrcyB1bnRpbCBhbnkgY3VycmVudGx5IHJ1bm5pbmcgYW5kIHNjaGVkdWxlZCBwb2xscyBhcmVcbiAgLy8gZG9uZSwgYW5kIHByZXZlbnRzIGFueSBmdXJ0aGVyIHBvbGxzIGZyb20gYmVpbmcgc2NoZWR1bGVkLiAobmV3XG4gIC8vIE9ic2VydmVIYW5kbGVzIGNhbiBiZSBhZGRlZCBhbmQgcmVjZWl2ZSB0aGVpciBpbml0aWFsIGFkZGVkIGNhbGxiYWNrcyxcbiAgLy8gdGhvdWdoLilcbiAgLy9cbiAgLy8gX3Jlc3VtZVBvbGxpbmcgaW1tZWRpYXRlbHkgcG9sbHMsIGFuZCBhbGxvd3MgZnVydGhlciBwb2xscyB0byBvY2N1ci5cbiAgX3N1c3BlbmRQb2xsaW5nOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gUHJldGVuZCB0aGF0IHRoZXJlJ3MgYW5vdGhlciBwb2xsIHNjaGVkdWxlZCAod2hpY2ggd2lsbCBwcmV2ZW50XG4gICAgLy8gX2Vuc3VyZVBvbGxJc1NjaGVkdWxlZCBmcm9tIHF1ZXVlaW5nIGFueSBtb3JlIHBvbGxzKS5cbiAgICArK3NlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZDtcbiAgICAvLyBOb3cgYmxvY2sgdW50aWwgYWxsIGN1cnJlbnRseSBydW5uaW5nIG9yIHNjaGVkdWxlZCBwb2xscyBhcmUgZG9uZS5cbiAgICBzZWxmLl90YXNrUXVldWUucnVuVGFzayhmdW5jdGlvbigpIHt9KTtcblxuICAgIC8vIENvbmZpcm0gdGhhdCB0aGVyZSBpcyBvbmx5IG9uZSBcInBvbGxcIiAodGhlIGZha2Ugb25lIHdlJ3JlIHByZXRlbmRpbmcgdG9cbiAgICAvLyBoYXZlKSBzY2hlZHVsZWQuXG4gICAgaWYgKHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCAhPT0gMSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgaXMgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgIHNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCk7XG4gIH0sXG4gIF9yZXN1bWVQb2xsaW5nOiBmdW5jdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgLy8gV2Ugc2hvdWxkIGJlIGluIHRoZSBzYW1lIHN0YXRlIGFzIGluIHRoZSBlbmQgb2YgX3N1c3BlbmRQb2xsaW5nLlxuICAgIGlmIChzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQgIT09IDEpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJfcG9sbHNTY2hlZHVsZWRCdXROb3RTdGFydGVkIGlzIFwiICtcbiAgICAgICAgICAgICAgICAgICAgICBzZWxmLl9wb2xsc1NjaGVkdWxlZEJ1dE5vdFN0YXJ0ZWQpO1xuICAgIC8vIFJ1biBhIHBvbGwgc3luY2hyb25vdXNseSAod2hpY2ggd2lsbCBjb3VudGVyYWN0IHRoZVxuICAgIC8vICsrX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZCBmcm9tIF9zdXNwZW5kUG9sbGluZykuXG4gICAgc2VsZi5fdGFza1F1ZXVlLnJ1blRhc2soZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcG9sbE1vbmdvKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgX3BvbGxNb25nbzogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICAtLXNlbGYuX3BvbGxzU2NoZWR1bGVkQnV0Tm90U3RhcnRlZDtcblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuXG4gICAgdmFyIGZpcnN0ID0gZmFsc2U7XG4gICAgdmFyIG5ld1Jlc3VsdHM7XG4gICAgdmFyIG9sZFJlc3VsdHMgPSBzZWxmLl9yZXN1bHRzO1xuICAgIGlmICghb2xkUmVzdWx0cykge1xuICAgICAgZmlyc3QgPSB0cnVlO1xuICAgICAgLy8gWFhYIG1heWJlIHVzZSBPcmRlcmVkRGljdCBpbnN0ZWFkP1xuICAgICAgb2xkUmVzdWx0cyA9IHNlbGYuX29yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIH1cblxuICAgIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrICYmIHNlbGYuX3Rlc3RPbmx5UG9sbENhbGxiYWNrKCk7XG5cbiAgICAvLyBTYXZlIHRoZSBsaXN0IG9mIHBlbmRpbmcgd3JpdGVzIHdoaWNoIHRoaXMgcm91bmQgd2lsbCBjb21taXQuXG4gICAgdmFyIHdyaXRlc0ZvckN5Y2xlID0gc2VsZi5fcGVuZGluZ1dyaXRlcztcbiAgICBzZWxmLl9wZW5kaW5nV3JpdGVzID0gW107XG5cbiAgICAvLyBHZXQgdGhlIG5ldyBxdWVyeSByZXN1bHRzLiAoVGhpcyB5aWVsZHMuKVxuICAgIHRyeSB7XG4gICAgICBuZXdSZXN1bHRzID0gc2VsZi5fc3luY2hyb25vdXNDdXJzb3IuZ2V0UmF3T2JqZWN0cyhzZWxmLl9vcmRlcmVkKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZmlyc3QgJiYgdHlwZW9mKGUuY29kZSkgPT09ICdudW1iZXInKSB7XG4gICAgICAgIC8vIFRoaXMgaXMgYW4gZXJyb3IgZG9jdW1lbnQgc2VudCB0byB1cyBieSBtb25nb2QsIG5vdCBhIGNvbm5lY3Rpb25cbiAgICAgICAgLy8gZXJyb3IgZ2VuZXJhdGVkIGJ5IHRoZSBjbGllbnQuIEFuZCB3ZSd2ZSBuZXZlciBzZWVuIHRoaXMgcXVlcnkgd29ya1xuICAgICAgICAvLyBzdWNjZXNzZnVsbHkuIFByb2JhYmx5IGl0J3MgYSBiYWQgc2VsZWN0b3Igb3Igc29tZXRoaW5nLCBzbyB3ZSBzaG91bGRcbiAgICAgICAgLy8gTk9UIHJldHJ5LiBJbnN0ZWFkLCB3ZSBzaG91bGQgaGFsdCB0aGUgb2JzZXJ2ZSAod2hpY2ggZW5kcyB1cCBjYWxsaW5nXG4gICAgICAgIC8vIGBzdG9wYCBvbiB1cykuXG4gICAgICAgIHNlbGYuX211bHRpcGxleGVyLnF1ZXJ5RXJyb3IoXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgXCJFeGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeSBcIiArXG4gICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKSArIFwiOiBcIiArIGUubWVzc2FnZSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIGdldFJhd09iamVjdHMgY2FuIHRocm93IGlmIHdlJ3JlIGhhdmluZyB0cm91YmxlIHRhbGtpbmcgdG8gdGhlXG4gICAgICAvLyBkYXRhYmFzZS4gIFRoYXQncyBmaW5lIC0tLSB3ZSB3aWxsIHJlcG9sbCBsYXRlciBhbnl3YXkuIEJ1dCB3ZSBzaG91bGRcbiAgICAgIC8vIG1ha2Ugc3VyZSBub3QgdG8gbG9zZSB0cmFjayBvZiB0aGlzIGN5Y2xlJ3Mgd3JpdGVzLlxuICAgICAgLy8gKEl0IGFsc28gY2FuIHRocm93IGlmIHRoZXJlJ3MganVzdCBzb21ldGhpbmcgaW52YWxpZCBhYm91dCB0aGlzIHF1ZXJ5O1xuICAgICAgLy8gdW5mb3J0dW5hdGVseSB0aGUgT2JzZXJ2ZURyaXZlciBBUEkgZG9lc24ndCBwcm92aWRlIGEgZ29vZCB3YXkgdG9cbiAgICAgIC8vIFwiY2FuY2VsXCIgdGhlIG9ic2VydmUgZnJvbSB0aGUgaW5zaWRlIGluIHRoaXMgY2FzZS5cbiAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KHNlbGYuX3BlbmRpbmdXcml0ZXMsIHdyaXRlc0ZvckN5Y2xlKTtcbiAgICAgIE1ldGVvci5fZGVidWcoXCJFeGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeSBcIiArXG4gICAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uKSArIFwiOiBcIiArIGUuc3RhY2spO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFJ1biBkaWZmcy5cbiAgICBpZiAoIXNlbGYuX3N0b3BwZWQpIHtcbiAgICAgIExvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5Q2hhbmdlcyhcbiAgICAgICAgc2VsZi5fb3JkZXJlZCwgb2xkUmVzdWx0cywgbmV3UmVzdWx0cywgc2VsZi5fbXVsdGlwbGV4ZXIpO1xuICAgIH1cblxuICAgIC8vIFNpZ25hbHMgdGhlIG11bHRpcGxleGVyIHRvIGFsbG93IGFsbCBvYnNlcnZlQ2hhbmdlcyBjYWxscyB0aGF0IHNoYXJlIHRoaXNcbiAgICAvLyBtdWx0aXBsZXhlciB0byByZXR1cm4uIChUaGlzIGhhcHBlbnMgYXN5bmNocm9ub3VzbHksIHZpYSB0aGVcbiAgICAvLyBtdWx0aXBsZXhlcidzIHF1ZXVlLilcbiAgICBpZiAoZmlyc3QpXG4gICAgICBzZWxmLl9tdWx0aXBsZXhlci5yZWFkeSgpO1xuXG4gICAgLy8gUmVwbGFjZSBzZWxmLl9yZXN1bHRzIGF0b21pY2FsbHkuICAoVGhpcyBhc3NpZ25tZW50IGlzIHdoYXQgbWFrZXMgYGZpcnN0YFxuICAgIC8vIHN0YXkgdGhyb3VnaCBvbiB0aGUgbmV4dCBjeWNsZSwgc28gd2UndmUgd2FpdGVkIHVudGlsIGFmdGVyIHdlJ3ZlXG4gICAgLy8gY29tbWl0dGVkIHRvIHJlYWR5LWluZyB0aGUgbXVsdGlwbGV4ZXIuKVxuICAgIHNlbGYuX3Jlc3VsdHMgPSBuZXdSZXN1bHRzO1xuXG4gICAgLy8gT25jZSB0aGUgT2JzZXJ2ZU11bHRpcGxleGVyIGhhcyBwcm9jZXNzZWQgZXZlcnl0aGluZyB3ZSd2ZSBkb25lIGluIHRoaXNcbiAgICAvLyByb3VuZCwgbWFyayBhbGwgdGhlIHdyaXRlcyB3aGljaCBleGlzdGVkIGJlZm9yZSB0aGlzIGNhbGwgYXNcbiAgICAvLyBjb21tbWl0dGVkLiAoSWYgbmV3IHdyaXRlcyBoYXZlIHNob3duIHVwIGluIHRoZSBtZWFudGltZSwgdGhlcmUnbGxcbiAgICAvLyBhbHJlYWR5IGJlIGFub3RoZXIgX3BvbGxNb25nbyB0YXNrIHNjaGVkdWxlZC4pXG4gICAgc2VsZi5fbXVsdGlwbGV4ZXIub25GbHVzaChmdW5jdGlvbiAoKSB7XG4gICAgICBfLmVhY2god3JpdGVzRm9yQ3ljbGUsIGZ1bmN0aW9uICh3KSB7XG4gICAgICAgIHcuY29tbWl0dGVkKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIHNlbGYuX3N0b3BwZWQgPSB0cnVlO1xuICAgIF8uZWFjaChzZWxmLl9zdG9wQ2FsbGJhY2tzLCBmdW5jdGlvbiAoYykgeyBjKCk7IH0pO1xuICAgIC8vIFJlbGVhc2UgYW55IHdyaXRlIGZlbmNlcyB0aGF0IGFyZSB3YWl0aW5nIG9uIHVzLlxuICAgIF8uZWFjaChzZWxmLl9wZW5kaW5nV3JpdGVzLCBmdW5jdGlvbiAodykge1xuICAgICAgdy5jb21taXR0ZWQoKTtcbiAgICB9KTtcbiAgICBQYWNrYWdlLmZhY3RzICYmIFBhY2thZ2UuZmFjdHMuRmFjdHMuaW5jcmVtZW50U2VydmVyRmFjdChcbiAgICAgIFwibW9uZ28tbGl2ZWRhdGFcIiwgXCJvYnNlcnZlLWRyaXZlcnMtcG9sbGluZ1wiLCAtMSk7XG4gIH1cbn0pO1xuIiwidmFyIEZ1dHVyZSA9IE5wbS5yZXF1aXJlKCdmaWJlcnMvZnV0dXJlJyk7XG5cbnZhciBQSEFTRSA9IHtcbiAgUVVFUllJTkc6IFwiUVVFUllJTkdcIixcbiAgRkVUQ0hJTkc6IFwiRkVUQ0hJTkdcIixcbiAgU1RFQURZOiBcIlNURUFEWVwiXG59O1xuXG4vLyBFeGNlcHRpb24gdGhyb3duIGJ5IF9uZWVkVG9Qb2xsUXVlcnkgd2hpY2ggdW5yb2xscyB0aGUgc3RhY2sgdXAgdG8gdGhlXG4vLyBlbmNsb3NpbmcgY2FsbCB0byBmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeS5cbnZhciBTd2l0Y2hlZFRvUXVlcnkgPSBmdW5jdGlvbiAoKSB7fTtcbnZhciBmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeSA9IGZ1bmN0aW9uIChmKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGYuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoIShlIGluc3RhbmNlb2YgU3dpdGNoZWRUb1F1ZXJ5KSlcbiAgICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH07XG59O1xuXG52YXIgY3VycmVudElkID0gMDtcblxuLy8gT3Bsb2dPYnNlcnZlRHJpdmVyIGlzIGFuIGFsdGVybmF0aXZlIHRvIFBvbGxpbmdPYnNlcnZlRHJpdmVyIHdoaWNoIGZvbGxvd3Ncbi8vIHRoZSBNb25nbyBvcGVyYXRpb24gbG9nIGluc3RlYWQgb2YganVzdCByZS1wb2xsaW5nIHRoZSBxdWVyeS4gSXQgb2JleXMgdGhlXG4vLyBzYW1lIHNpbXBsZSBpbnRlcmZhY2U6IGNvbnN0cnVjdGluZyBpdCBzdGFydHMgc2VuZGluZyBvYnNlcnZlQ2hhbmdlc1xuLy8gY2FsbGJhY2tzIChhbmQgYSByZWFkeSgpIGludm9jYXRpb24pIHRvIHRoZSBPYnNlcnZlTXVsdGlwbGV4ZXIsIGFuZCB5b3Ugc3RvcFxuLy8gaXQgYnkgY2FsbGluZyB0aGUgc3RvcCgpIG1ldGhvZC5cbk9wbG9nT2JzZXJ2ZURyaXZlciA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5fdXNlc09wbG9nID0gdHJ1ZTsgIC8vIHRlc3RzIGxvb2sgYXQgdGhpc1xuXG4gIHNlbGYuX2lkID0gY3VycmVudElkO1xuICBjdXJyZW50SWQrKztcblxuICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiA9IG9wdGlvbnMuY3Vyc29yRGVzY3JpcHRpb247XG4gIHNlbGYuX21vbmdvSGFuZGxlID0gb3B0aW9ucy5tb25nb0hhbmRsZTtcbiAgc2VsZi5fbXVsdGlwbGV4ZXIgPSBvcHRpb25zLm11bHRpcGxleGVyO1xuXG4gIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICB0aHJvdyBFcnJvcihcIk9wbG9nT2JzZXJ2ZURyaXZlciBvbmx5IHN1cHBvcnRzIHVub3JkZXJlZCBvYnNlcnZlQ2hhbmdlc1wiKTtcbiAgfVxuXG4gIHZhciBzb3J0ZXIgPSBvcHRpb25zLnNvcnRlcjtcbiAgLy8gV2UgZG9uJ3Qgc3VwcG9ydCAkbmVhciBhbmQgb3RoZXIgZ2VvLXF1ZXJpZXMgc28gaXQncyBPSyB0byBpbml0aWFsaXplIHRoZVxuICAvLyBjb21wYXJhdG9yIG9ubHkgb25jZSBpbiB0aGUgY29uc3RydWN0b3IuXG4gIHZhciBjb21wYXJhdG9yID0gc29ydGVyICYmIHNvcnRlci5nZXRDb21wYXJhdG9yKCk7XG5cbiAgaWYgKG9wdGlvbnMuY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucy5saW1pdCkge1xuICAgIC8vIFRoZXJlIGFyZSBzZXZlcmFsIHByb3BlcnRpZXMgb3JkZXJlZCBkcml2ZXIgaW1wbGVtZW50czpcbiAgICAvLyAtIF9saW1pdCBpcyBhIHBvc2l0aXZlIG51bWJlclxuICAgIC8vIC0gX2NvbXBhcmF0b3IgaXMgYSBmdW5jdGlvbi1jb21wYXJhdG9yIGJ5IHdoaWNoIHRoZSBxdWVyeSBpcyBvcmRlcmVkXG4gICAgLy8gLSBfdW5wdWJsaXNoZWRCdWZmZXIgaXMgbm9uLW51bGwgTWluL01heCBIZWFwLFxuICAgIC8vICAgICAgICAgICAgICAgICAgICAgIHRoZSBlbXB0eSBidWZmZXIgaW4gU1RFQURZIHBoYXNlIGltcGxpZXMgdGhhdCB0aGVcbiAgICAvLyAgICAgICAgICAgICAgICAgICAgICBldmVyeXRoaW5nIHRoYXQgbWF0Y2hlcyB0aGUgcXVlcmllcyBzZWxlY3RvciBmaXRzXG4gICAgLy8gICAgICAgICAgICAgICAgICAgICAgaW50byBwdWJsaXNoZWQgc2V0LlxuICAgIC8vIC0gX3B1Ymxpc2hlZCAtIE1pbiBIZWFwIChhbHNvIGltcGxlbWVudHMgSWRNYXAgbWV0aG9kcylcblxuICAgIHZhciBoZWFwT3B0aW9ucyA9IHsgSWRNYXA6IExvY2FsQ29sbGVjdGlvbi5fSWRNYXAgfTtcbiAgICBzZWxmLl9saW1pdCA9IHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMubGltaXQ7XG4gICAgc2VsZi5fY29tcGFyYXRvciA9IGNvbXBhcmF0b3I7XG4gICAgc2VsZi5fc29ydGVyID0gc29ydGVyO1xuICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyID0gbmV3IE1pbk1heEhlYXAoY29tcGFyYXRvciwgaGVhcE9wdGlvbnMpO1xuICAgIC8vIFdlIG5lZWQgc29tZXRoaW5nIHRoYXQgY2FuIGZpbmQgTWF4IHZhbHVlIGluIGFkZGl0aW9uIHRvIElkTWFwIGludGVyZmFjZVxuICAgIHNlbGYuX3B1Ymxpc2hlZCA9IG5ldyBNYXhIZWFwKGNvbXBhcmF0b3IsIGhlYXBPcHRpb25zKTtcbiAgfSBlbHNlIHtcbiAgICBzZWxmLl9saW1pdCA9IDA7XG4gICAgc2VsZi5fY29tcGFyYXRvciA9IG51bGw7XG4gICAgc2VsZi5fc29ydGVyID0gbnVsbDtcbiAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlciA9IG51bGw7XG4gICAgc2VsZi5fcHVibGlzaGVkID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gIH1cblxuICAvLyBJbmRpY2F0ZXMgaWYgaXQgaXMgc2FmZSB0byBpbnNlcnQgYSBuZXcgZG9jdW1lbnQgYXQgdGhlIGVuZCBvZiB0aGUgYnVmZmVyXG4gIC8vIGZvciB0aGlzIHF1ZXJ5LiBpLmUuIGl0IGlzIGtub3duIHRoYXQgdGhlcmUgYXJlIG5vIGRvY3VtZW50cyBtYXRjaGluZyB0aGVcbiAgLy8gc2VsZWN0b3IgdGhvc2UgYXJlIG5vdCBpbiBwdWJsaXNoZWQgb3IgYnVmZmVyLlxuICBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgPSBmYWxzZTtcblxuICBzZWxmLl9zdG9wcGVkID0gZmFsc2U7XG4gIHNlbGYuX3N0b3BIYW5kbGVzID0gW107XG5cbiAgUGFja2FnZS5mYWN0cyAmJiBQYWNrYWdlLmZhY3RzLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgXCJtb25nby1saXZlZGF0YVwiLCBcIm9ic2VydmUtZHJpdmVycy1vcGxvZ1wiLCAxKTtcblxuICBzZWxmLl9yZWdpc3RlclBoYXNlQ2hhbmdlKFBIQVNFLlFVRVJZSU5HKTtcblxuICBzZWxmLl9tYXRjaGVyID0gb3B0aW9ucy5tYXRjaGVyO1xuICB2YXIgcHJvamVjdGlvbiA9IHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLm9wdGlvbnMuZmllbGRzIHx8IHt9O1xuICBzZWxmLl9wcm9qZWN0aW9uRm4gPSBMb2NhbENvbGxlY3Rpb24uX2NvbXBpbGVQcm9qZWN0aW9uKHByb2plY3Rpb24pO1xuICAvLyBQcm9qZWN0aW9uIGZ1bmN0aW9uLCByZXN1bHQgb2YgY29tYmluaW5nIGltcG9ydGFudCBmaWVsZHMgZm9yIHNlbGVjdG9yIGFuZFxuICAvLyBleGlzdGluZyBmaWVsZHMgcHJvamVjdGlvblxuICBzZWxmLl9zaGFyZWRQcm9qZWN0aW9uID0gc2VsZi5fbWF0Y2hlci5jb21iaW5lSW50b1Byb2plY3Rpb24ocHJvamVjdGlvbik7XG4gIGlmIChzb3J0ZXIpXG4gICAgc2VsZi5fc2hhcmVkUHJvamVjdGlvbiA9IHNvcnRlci5jb21iaW5lSW50b1Byb2plY3Rpb24oc2VsZi5fc2hhcmVkUHJvamVjdGlvbik7XG4gIHNlbGYuX3NoYXJlZFByb2plY3Rpb25GbiA9IExvY2FsQ29sbGVjdGlvbi5fY29tcGlsZVByb2plY3Rpb24oXG4gICAgc2VsZi5fc2hhcmVkUHJvamVjdGlvbik7XG5cbiAgc2VsZi5fbmVlZFRvRmV0Y2ggPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcgPSBudWxsO1xuICBzZWxmLl9mZXRjaEdlbmVyYXRpb24gPSAwO1xuXG4gIHNlbGYuX3JlcXVlcnlXaGVuRG9uZVRoaXNRdWVyeSA9IGZhbHNlO1xuICBzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5ID0gW107XG5cbiAgLy8gSWYgdGhlIG9wbG9nIGhhbmRsZSB0ZWxscyB1cyB0aGF0IGl0IHNraXBwZWQgc29tZSBlbnRyaWVzIChiZWNhdXNlIGl0IGdvdFxuICAvLyBiZWhpbmQsIHNheSksIHJlLXBvbGwuXG4gIHNlbGYuX3N0b3BIYW5kbGVzLnB1c2goc2VsZi5fbW9uZ29IYW5kbGUuX29wbG9nSGFuZGxlLm9uU2tpcHBlZEVudHJpZXMoXG4gICAgZmluaXNoSWZOZWVkVG9Qb2xsUXVlcnkoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fbmVlZFRvUG9sbFF1ZXJ5KCk7XG4gICAgfSlcbiAgKSk7XG5cbiAgZm9yRWFjaFRyaWdnZXIoc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24sIGZ1bmN0aW9uICh0cmlnZ2VyKSB7XG4gICAgc2VsZi5fc3RvcEhhbmRsZXMucHVzaChzZWxmLl9tb25nb0hhbmRsZS5fb3Bsb2dIYW5kbGUub25PcGxvZ0VudHJ5KFxuICAgICAgdHJpZ2dlciwgZnVuY3Rpb24gKG5vdGlmaWNhdGlvbikge1xuICAgICAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeShmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgdmFyIG9wID0gbm90aWZpY2F0aW9uLm9wO1xuICAgICAgICAgIGlmIChub3RpZmljYXRpb24uZHJvcENvbGxlY3Rpb24gfHwgbm90aWZpY2F0aW9uLmRyb3BEYXRhYmFzZSkge1xuICAgICAgICAgICAgLy8gTm90ZTogdGhpcyBjYWxsIGlzIG5vdCBhbGxvd2VkIHRvIGJsb2NrIG9uIGFueXRoaW5nIChlc3BlY2lhbGx5XG4gICAgICAgICAgICAvLyBvbiB3YWl0aW5nIGZvciBvcGxvZyBlbnRyaWVzIHRvIGNhdGNoIHVwKSBiZWNhdXNlIHRoYXQgd2lsbCBibG9ja1xuICAgICAgICAgICAgLy8gb25PcGxvZ0VudHJ5IVxuICAgICAgICAgICAgc2VsZi5fbmVlZFRvUG9sbFF1ZXJ5KCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIEFsbCBvdGhlciBvcGVyYXRvcnMgc2hvdWxkIGJlIGhhbmRsZWQgZGVwZW5kaW5nIG9uIHBoYXNlXG4gICAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLlFVRVJZSU5HKSB7XG4gICAgICAgICAgICAgIHNlbGYuX2hhbmRsZU9wbG9nRW50cnlRdWVyeWluZyhvcCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBzZWxmLl9oYW5kbGVPcGxvZ0VudHJ5U3RlYWR5T3JGZXRjaGluZyhvcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9KSk7XG4gICAgICB9XG4gICAgKSk7XG4gIH0pO1xuXG4gIC8vIFhYWCBvcmRlcmluZyB3LnIudC4gZXZlcnl0aGluZyBlbHNlP1xuICBzZWxmLl9zdG9wSGFuZGxlcy5wdXNoKGxpc3RlbkFsbChcbiAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbiwgZnVuY3Rpb24gKG5vdGlmaWNhdGlvbikge1xuICAgICAgLy8gSWYgd2UncmUgbm90IGluIGEgcHJlLWZpcmUgd3JpdGUgZmVuY2UsIHdlIGRvbid0IGhhdmUgdG8gZG8gYW55dGhpbmcuXG4gICAgICB2YXIgZmVuY2UgPSBERFBTZXJ2ZXIuX0N1cnJlbnRXcml0ZUZlbmNlLmdldCgpO1xuICAgICAgaWYgKCFmZW5jZSB8fCBmZW5jZS5maXJlZClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICBpZiAoZmVuY2UuX29wbG9nT2JzZXJ2ZURyaXZlcnMpIHtcbiAgICAgICAgZmVuY2UuX29wbG9nT2JzZXJ2ZURyaXZlcnNbc2VsZi5faWRdID0gc2VsZjtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBmZW5jZS5fb3Bsb2dPYnNlcnZlRHJpdmVycyA9IHt9O1xuICAgICAgZmVuY2UuX29wbG9nT2JzZXJ2ZURyaXZlcnNbc2VsZi5faWRdID0gc2VsZjtcblxuICAgICAgZmVuY2Uub25CZWZvcmVGaXJlKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGRyaXZlcnMgPSBmZW5jZS5fb3Bsb2dPYnNlcnZlRHJpdmVycztcbiAgICAgICAgZGVsZXRlIGZlbmNlLl9vcGxvZ09ic2VydmVEcml2ZXJzO1xuXG4gICAgICAgIC8vIFRoaXMgZmVuY2UgY2Fubm90IGZpcmUgdW50aWwgd2UndmUgY2F1Z2h0IHVwIHRvIFwidGhpcyBwb2ludFwiIGluIHRoZVxuICAgICAgICAvLyBvcGxvZywgYW5kIGFsbCBvYnNlcnZlcnMgbWFkZSBpdCBiYWNrIHRvIHRoZSBzdGVhZHkgc3RhdGUuXG4gICAgICAgIHNlbGYuX21vbmdvSGFuZGxlLl9vcGxvZ0hhbmRsZS53YWl0VW50aWxDYXVnaHRVcCgpO1xuXG4gICAgICAgIF8uZWFjaChkcml2ZXJzLCBmdW5jdGlvbiAoZHJpdmVyKSB7XG4gICAgICAgICAgaWYgKGRyaXZlci5fc3RvcHBlZClcbiAgICAgICAgICAgIHJldHVybjtcblxuICAgICAgICAgIHZhciB3cml0ZSA9IGZlbmNlLmJlZ2luV3JpdGUoKTtcbiAgICAgICAgICBpZiAoZHJpdmVyLl9waGFzZSA9PT0gUEhBU0UuU1RFQURZKSB7XG4gICAgICAgICAgICAvLyBNYWtlIHN1cmUgdGhhdCBhbGwgb2YgdGhlIGNhbGxiYWNrcyBoYXZlIG1hZGUgaXQgdGhyb3VnaCB0aGVcbiAgICAgICAgICAgIC8vIG11bHRpcGxleGVyIGFuZCBiZWVuIGRlbGl2ZXJlZCB0byBPYnNlcnZlSGFuZGxlcyBiZWZvcmUgY29tbWl0dGluZ1xuICAgICAgICAgICAgLy8gd3JpdGVzLlxuICAgICAgICAgICAgZHJpdmVyLl9tdWx0aXBsZXhlci5vbkZsdXNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgd3JpdGUuY29tbWl0dGVkKCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZHJpdmVyLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5LnB1c2god3JpdGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gICkpO1xuXG4gIC8vIFdoZW4gTW9uZ28gZmFpbHMgb3Zlciwgd2UgbmVlZCB0byByZXBvbGwgdGhlIHF1ZXJ5LCBpbiBjYXNlIHdlIHByb2Nlc3NlZCBhblxuICAvLyBvcGxvZyBlbnRyeSB0aGF0IGdvdCByb2xsZWQgYmFjay5cbiAgc2VsZi5fc3RvcEhhbmRsZXMucHVzaChzZWxmLl9tb25nb0hhbmRsZS5fb25GYWlsb3ZlcihmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeShcbiAgICBmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9uZWVkVG9Qb2xsUXVlcnkoKTtcbiAgICB9KSkpO1xuXG4gIC8vIEdpdmUgX29ic2VydmVDaGFuZ2VzIGEgY2hhbmNlIHRvIGFkZCB0aGUgbmV3IE9ic2VydmVIYW5kbGUgdG8gb3VyXG4gIC8vIG11bHRpcGxleGVyLCBzbyB0aGF0IHRoZSBhZGRlZCBjYWxscyBnZXQgc3RyZWFtZWQuXG4gIE1ldGVvci5kZWZlcihmaW5pc2hJZk5lZWRUb1BvbGxRdWVyeShmdW5jdGlvbiAoKSB7XG4gICAgc2VsZi5fcnVuSW5pdGlhbFF1ZXJ5KCk7XG4gIH0pKTtcbn07XG5cbl8uZXh0ZW5kKE9wbG9nT2JzZXJ2ZURyaXZlci5wcm90b3R5cGUsIHtcbiAgX2FkZFB1Ymxpc2hlZDogZnVuY3Rpb24gKGlkLCBkb2MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIGZpZWxkcyA9IF8uY2xvbmUoZG9jKTtcbiAgICAgIGRlbGV0ZSBmaWVsZHMuX2lkO1xuICAgICAgc2VsZi5fcHVibGlzaGVkLnNldChpZCwgc2VsZi5fc2hhcmVkUHJvamVjdGlvbkZuKGRvYykpO1xuICAgICAgc2VsZi5fbXVsdGlwbGV4ZXIuYWRkZWQoaWQsIHNlbGYuX3Byb2plY3Rpb25GbihmaWVsZHMpKTtcblxuICAgICAgLy8gQWZ0ZXIgYWRkaW5nIHRoaXMgZG9jdW1lbnQsIHRoZSBwdWJsaXNoZWQgc2V0IG1pZ2h0IGJlIG92ZXJmbG93ZWRcbiAgICAgIC8vIChleGNlZWRpbmcgY2FwYWNpdHkgc3BlY2lmaWVkIGJ5IGxpbWl0KS4gSWYgc28sIHB1c2ggdGhlIG1heGltdW1cbiAgICAgIC8vIGVsZW1lbnQgdG8gdGhlIGJ1ZmZlciwgd2UgbWlnaHQgd2FudCB0byBzYXZlIGl0IGluIG1lbW9yeSB0byByZWR1Y2UgdGhlXG4gICAgICAvLyBhbW91bnQgb2YgTW9uZ28gbG9va3VwcyBpbiB0aGUgZnV0dXJlLlxuICAgICAgaWYgKHNlbGYuX2xpbWl0ICYmIHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgPiBzZWxmLl9saW1pdCkge1xuICAgICAgICAvLyBYWFggaW4gdGhlb3J5IHRoZSBzaXplIG9mIHB1Ymxpc2hlZCBpcyBubyBtb3JlIHRoYW4gbGltaXQrMVxuICAgICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLnNpemUoKSAhPT0gc2VsZi5fbGltaXQgKyAxKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQWZ0ZXIgYWRkaW5nIHRvIHB1Ymxpc2hlZCwgXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAoc2VsZi5fcHVibGlzaGVkLnNpemUoKSAtIHNlbGYuX2xpbWl0KSArXG4gICAgICAgICAgICAgICAgICAgICAgICAgIFwiIGRvY3VtZW50cyBhcmUgb3ZlcmZsb3dpbmcgdGhlIHNldFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHZhciBvdmVyZmxvd2luZ0RvY0lkID0gc2VsZi5fcHVibGlzaGVkLm1heEVsZW1lbnRJZCgpO1xuICAgICAgICB2YXIgb3ZlcmZsb3dpbmdEb2MgPSBzZWxmLl9wdWJsaXNoZWQuZ2V0KG92ZXJmbG93aW5nRG9jSWQpO1xuXG4gICAgICAgIGlmIChFSlNPTi5lcXVhbHMob3ZlcmZsb3dpbmdEb2NJZCwgaWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVGhlIGRvY3VtZW50IGp1c3QgYWRkZWQgaXMgb3ZlcmZsb3dpbmcgdGhlIHB1Ymxpc2hlZCBzZXRcIik7XG4gICAgICAgIH1cblxuICAgICAgICBzZWxmLl9wdWJsaXNoZWQucmVtb3ZlKG92ZXJmbG93aW5nRG9jSWQpO1xuICAgICAgICBzZWxmLl9tdWx0aXBsZXhlci5yZW1vdmVkKG92ZXJmbG93aW5nRG9jSWQpO1xuICAgICAgICBzZWxmLl9hZGRCdWZmZXJlZChvdmVyZmxvd2luZ0RvY0lkLCBvdmVyZmxvd2luZ0RvYyk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIF9yZW1vdmVQdWJsaXNoZWQ6IGZ1bmN0aW9uIChpZCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9wdWJsaXNoZWQucmVtb3ZlKGlkKTtcbiAgICAgIHNlbGYuX211bHRpcGxleGVyLnJlbW92ZWQoaWQpO1xuICAgICAgaWYgKCEgc2VsZi5fbGltaXQgfHwgc2VsZi5fcHVibGlzaGVkLnNpemUoKSA9PT0gc2VsZi5fbGltaXQpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgPiBzZWxmLl9saW1pdClcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJzZWxmLl9wdWJsaXNoZWQgZ290IHRvbyBiaWdcIik7XG5cbiAgICAgIC8vIE9LLCB3ZSBhcmUgcHVibGlzaGluZyBsZXNzIHRoYW4gdGhlIGxpbWl0LiBNYXliZSB3ZSBzaG91bGQgbG9vayBpbiB0aGVcbiAgICAgIC8vIGJ1ZmZlciB0byBmaW5kIHRoZSBuZXh0IGVsZW1lbnQgcGFzdCB3aGF0IHdlIHdlcmUgcHVibGlzaGluZyBiZWZvcmUuXG5cbiAgICAgIGlmICghc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZW1wdHkoKSkge1xuICAgICAgICAvLyBUaGVyZSdzIHNvbWV0aGluZyBpbiB0aGUgYnVmZmVyOyBtb3ZlIHRoZSBmaXJzdCB0aGluZyBpbiBpdCB0b1xuICAgICAgICAvLyBfcHVibGlzaGVkLlxuICAgICAgICB2YXIgbmV3RG9jSWQgPSBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5taW5FbGVtZW50SWQoKTtcbiAgICAgICAgdmFyIG5ld0RvYyA9IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChuZXdEb2NJZCk7XG4gICAgICAgIHNlbGYuX3JlbW92ZUJ1ZmZlcmVkKG5ld0RvY0lkKTtcbiAgICAgICAgc2VsZi5fYWRkUHVibGlzaGVkKG5ld0RvY0lkLCBuZXdEb2MpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIFRoZXJlJ3Mgbm90aGluZyBpbiB0aGUgYnVmZmVyLiAgVGhpcyBjb3VsZCBtZWFuIG9uZSBvZiBhIGZldyB0aGluZ3MuXG5cbiAgICAgIC8vIChhKSBXZSBjb3VsZCBiZSBpbiB0aGUgbWlkZGxlIG9mIHJlLXJ1bm5pbmcgdGhlIHF1ZXJ5IChzcGVjaWZpY2FsbHksIHdlXG4gICAgICAvLyBjb3VsZCBiZSBpbiBfcHVibGlzaE5ld1Jlc3VsdHMpLiBJbiB0aGF0IGNhc2UsIF91bnB1Ymxpc2hlZEJ1ZmZlciBpc1xuICAgICAgLy8gZW1wdHkgYmVjYXVzZSB3ZSBjbGVhciBpdCBhdCB0aGUgYmVnaW5uaW5nIG9mIF9wdWJsaXNoTmV3UmVzdWx0cy4gSW5cbiAgICAgIC8vIHRoaXMgY2FzZSwgb3VyIGNhbGxlciBhbHJlYWR5IGtub3dzIHRoZSBlbnRpcmUgYW5zd2VyIHRvIHRoZSBxdWVyeSBhbmRcbiAgICAgIC8vIHdlIGRvbid0IG5lZWQgdG8gZG8gYW55dGhpbmcgZmFuY3kgaGVyZS4gIEp1c3QgcmV0dXJuLlxuICAgICAgaWYgKHNlbGYuX3BoYXNlID09PSBQSEFTRS5RVUVSWUlORylcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAvLyAoYikgV2UncmUgcHJldHR5IGNvbmZpZGVudCB0aGF0IHRoZSB1bmlvbiBvZiBfcHVibGlzaGVkIGFuZFxuICAgICAgLy8gX3VucHVibGlzaGVkQnVmZmVyIGNvbnRhaW4gYWxsIGRvY3VtZW50cyB0aGF0IG1hdGNoIHNlbGVjdG9yLiBCZWNhdXNlXG4gICAgICAvLyBfdW5wdWJsaXNoZWRCdWZmZXIgaXMgZW1wdHksIHRoYXQgbWVhbnMgd2UncmUgY29uZmlkZW50IHRoYXQgX3B1Ymxpc2hlZFxuICAgICAgLy8gY29udGFpbnMgYWxsIGRvY3VtZW50cyB0aGF0IG1hdGNoIHNlbGVjdG9yLiBTbyB3ZSBoYXZlIG5vdGhpbmcgdG8gZG8uXG4gICAgICBpZiAoc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIC8vIChjKSBNYXliZSB0aGVyZSBhcmUgb3RoZXIgZG9jdW1lbnRzIG91dCB0aGVyZSB0aGF0IHNob3VsZCBiZSBpbiBvdXJcbiAgICAgIC8vIGJ1ZmZlci4gQnV0IGluIHRoYXQgY2FzZSwgd2hlbiB3ZSBlbXB0aWVkIF91bnB1Ymxpc2hlZEJ1ZmZlciBpblxuICAgICAgLy8gX3JlbW92ZUJ1ZmZlcmVkLCB3ZSBzaG91bGQgaGF2ZSBjYWxsZWQgX25lZWRUb1BvbGxRdWVyeSwgd2hpY2ggd2lsbFxuICAgICAgLy8gZWl0aGVyIHB1dCBzb21ldGhpbmcgaW4gX3VucHVibGlzaGVkQnVmZmVyIG9yIHNldCBfc2FmZUFwcGVuZFRvQnVmZmVyXG4gICAgICAvLyAob3IgYm90aCksIGFuZCBpdCB3aWxsIHB1dCB1cyBpbiBRVUVSWUlORyBmb3IgdGhhdCB3aG9sZSB0aW1lLiBTbyBpblxuICAgICAgLy8gZmFjdCwgd2Ugc2hvdWxkbid0IGJlIGFibGUgdG8gZ2V0IGhlcmUuXG5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkJ1ZmZlciBpbmV4cGxpY2FibHkgZW1wdHlcIik7XG4gICAgfSk7XG4gIH0sXG4gIF9jaGFuZ2VQdWJsaXNoZWQ6IGZ1bmN0aW9uIChpZCwgb2xkRG9jLCBuZXdEb2MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fcHVibGlzaGVkLnNldChpZCwgc2VsZi5fc2hhcmVkUHJvamVjdGlvbkZuKG5ld0RvYykpO1xuICAgICAgdmFyIHByb2plY3RlZE5ldyA9IHNlbGYuX3Byb2plY3Rpb25GbihuZXdEb2MpO1xuICAgICAgdmFyIHByb2plY3RlZE9sZCA9IHNlbGYuX3Byb2plY3Rpb25GbihvbGREb2MpO1xuICAgICAgdmFyIGNoYW5nZWQgPSBEaWZmU2VxdWVuY2UubWFrZUNoYW5nZWRGaWVsZHMoXG4gICAgICAgIHByb2plY3RlZE5ldywgcHJvamVjdGVkT2xkKTtcbiAgICAgIGlmICghXy5pc0VtcHR5KGNoYW5nZWQpKVxuICAgICAgICBzZWxmLl9tdWx0aXBsZXhlci5jaGFuZ2VkKGlkLCBjaGFuZ2VkKTtcbiAgICB9KTtcbiAgfSxcbiAgX2FkZEJ1ZmZlcmVkOiBmdW5jdGlvbiAoaWQsIGRvYykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zZXQoaWQsIHNlbGYuX3NoYXJlZFByb2plY3Rpb25Gbihkb2MpKTtcblxuICAgICAgLy8gSWYgc29tZXRoaW5nIGlzIG92ZXJmbG93aW5nIHRoZSBidWZmZXIsIHdlIGp1c3QgcmVtb3ZlIGl0IGZyb20gY2FjaGVcbiAgICAgIGlmIChzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgPiBzZWxmLl9saW1pdCkge1xuICAgICAgICB2YXIgbWF4QnVmZmVyZWRJZCA9IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLm1heEVsZW1lbnRJZCgpO1xuXG4gICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnJlbW92ZShtYXhCdWZmZXJlZElkKTtcblxuICAgICAgICAvLyBTaW5jZSBzb21ldGhpbmcgbWF0Y2hpbmcgaXMgcmVtb3ZlZCBmcm9tIGNhY2hlIChib3RoIHB1Ymxpc2hlZCBzZXQgYW5kXG4gICAgICAgIC8vIGJ1ZmZlciksIHNldCBmbGFnIHRvIGZhbHNlXG4gICAgICAgIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICAvLyBJcyBjYWxsZWQgZWl0aGVyIHRvIHJlbW92ZSB0aGUgZG9jIGNvbXBsZXRlbHkgZnJvbSBtYXRjaGluZyBzZXQgb3IgdG8gbW92ZVxuICAvLyBpdCB0byB0aGUgcHVibGlzaGVkIHNldCBsYXRlci5cbiAgX3JlbW92ZUJ1ZmZlcmVkOiBmdW5jdGlvbiAoaWQpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIucmVtb3ZlKGlkKTtcbiAgICAgIC8vIFRvIGtlZXAgdGhlIGNvbnRyYWN0IFwiYnVmZmVyIGlzIG5ldmVyIGVtcHR5IGluIFNURUFEWSBwaGFzZSB1bmxlc3MgdGhlXG4gICAgICAvLyBldmVyeXRoaW5nIG1hdGNoaW5nIGZpdHMgaW50byBwdWJsaXNoZWRcIiB0cnVlLCB3ZSBwb2xsIGV2ZXJ5dGhpbmcgYXNcbiAgICAgIC8vIHNvb24gYXMgd2Ugc2VlIHRoZSBidWZmZXIgYmVjb21pbmcgZW1wdHkuXG4gICAgICBpZiAoISBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgJiYgISBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIpXG4gICAgICAgIHNlbGYuX25lZWRUb1BvbGxRdWVyeSgpO1xuICAgIH0pO1xuICB9LFxuICAvLyBDYWxsZWQgd2hlbiBhIGRvY3VtZW50IGhhcyBqb2luZWQgdGhlIFwiTWF0Y2hpbmdcIiByZXN1bHRzIHNldC5cbiAgLy8gVGFrZXMgcmVzcG9uc2liaWxpdHkgb2Yga2VlcGluZyBfdW5wdWJsaXNoZWRCdWZmZXIgaW4gc3luYyB3aXRoIF9wdWJsaXNoZWRcbiAgLy8gYW5kIHRoZSBlZmZlY3Qgb2YgbGltaXQgZW5mb3JjZWQuXG4gIF9hZGRNYXRjaGluZzogZnVuY3Rpb24gKGRvYykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgaWQgPSBkb2MuX2lkO1xuICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpKVxuICAgICAgICB0aHJvdyBFcnJvcihcInRyaWVkIHRvIGFkZCBzb21ldGhpbmcgYWxyZWFkeSBwdWJsaXNoZWQgXCIgKyBpZCk7XG4gICAgICBpZiAoc2VsZi5fbGltaXQgJiYgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuaGFzKGlkKSlcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJ0cmllZCB0byBhZGQgc29tZXRoaW5nIGFscmVhZHkgZXhpc3RlZCBpbiBidWZmZXIgXCIgKyBpZCk7XG5cbiAgICAgIHZhciBsaW1pdCA9IHNlbGYuX2xpbWl0O1xuICAgICAgdmFyIGNvbXBhcmF0b3IgPSBzZWxmLl9jb21wYXJhdG9yO1xuICAgICAgdmFyIG1heFB1Ymxpc2hlZCA9IChsaW1pdCAmJiBzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpID4gMCkgP1xuICAgICAgICBzZWxmLl9wdWJsaXNoZWQuZ2V0KHNlbGYuX3B1Ymxpc2hlZC5tYXhFbGVtZW50SWQoKSkgOiBudWxsO1xuICAgICAgdmFyIG1heEJ1ZmZlcmVkID0gKGxpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSA+IDApXG4gICAgICAgID8gc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuZ2V0KHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLm1heEVsZW1lbnRJZCgpKVxuICAgICAgICA6IG51bGw7XG4gICAgICAvLyBUaGUgcXVlcnkgaXMgdW5saW1pdGVkIG9yIGRpZG4ndCBwdWJsaXNoIGVub3VnaCBkb2N1bWVudHMgeWV0IG9yIHRoZVxuICAgICAgLy8gbmV3IGRvY3VtZW50IHdvdWxkIGZpdCBpbnRvIHB1Ymxpc2hlZCBzZXQgcHVzaGluZyB0aGUgbWF4aW11bSBlbGVtZW50XG4gICAgICAvLyBvdXQsIHRoZW4gd2UgbmVlZCB0byBwdWJsaXNoIHRoZSBkb2MuXG4gICAgICB2YXIgdG9QdWJsaXNoID0gISBsaW1pdCB8fCBzZWxmLl9wdWJsaXNoZWQuc2l6ZSgpIDwgbGltaXQgfHxcbiAgICAgICAgY29tcGFyYXRvcihkb2MsIG1heFB1Ymxpc2hlZCkgPCAwO1xuXG4gICAgICAvLyBPdGhlcndpc2Ugd2UgbWlnaHQgbmVlZCB0byBidWZmZXIgaXQgKG9ubHkgaW4gY2FzZSBvZiBsaW1pdGVkIHF1ZXJ5KS5cbiAgICAgIC8vIEJ1ZmZlcmluZyBpcyBhbGxvd2VkIGlmIHRoZSBidWZmZXIgaXMgbm90IGZpbGxlZCB1cCB5ZXQgYW5kIGFsbFxuICAgICAgLy8gbWF0Y2hpbmcgZG9jcyBhcmUgZWl0aGVyIGluIHRoZSBwdWJsaXNoZWQgc2V0IG9yIGluIHRoZSBidWZmZXIuXG4gICAgICB2YXIgY2FuQXBwZW5kVG9CdWZmZXIgPSAhdG9QdWJsaXNoICYmIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciAmJlxuICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgPCBsaW1pdDtcblxuICAgICAgLy8gT3IgaWYgaXQgaXMgc21hbGwgZW5vdWdoIHRvIGJlIHNhZmVseSBpbnNlcnRlZCB0byB0aGUgbWlkZGxlIG9yIHRoZVxuICAgICAgLy8gYmVnaW5uaW5nIG9mIHRoZSBidWZmZXIuXG4gICAgICB2YXIgY2FuSW5zZXJ0SW50b0J1ZmZlciA9ICF0b1B1Ymxpc2ggJiYgbWF4QnVmZmVyZWQgJiZcbiAgICAgICAgY29tcGFyYXRvcihkb2MsIG1heEJ1ZmZlcmVkKSA8PSAwO1xuXG4gICAgICB2YXIgdG9CdWZmZXIgPSBjYW5BcHBlbmRUb0J1ZmZlciB8fCBjYW5JbnNlcnRJbnRvQnVmZmVyO1xuXG4gICAgICBpZiAodG9QdWJsaXNoKSB7XG4gICAgICAgIHNlbGYuX2FkZFB1Ymxpc2hlZChpZCwgZG9jKTtcbiAgICAgIH0gZWxzZSBpZiAodG9CdWZmZXIpIHtcbiAgICAgICAgc2VsZi5fYWRkQnVmZmVyZWQoaWQsIGRvYyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBkcm9wcGluZyBpdCBhbmQgbm90IHNhdmluZyB0byB0aGUgY2FjaGVcbiAgICAgICAgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG4gIC8vIENhbGxlZCB3aGVuIGEgZG9jdW1lbnQgbGVhdmVzIHRoZSBcIk1hdGNoaW5nXCIgcmVzdWx0cyBzZXQuXG4gIC8vIFRha2VzIHJlc3BvbnNpYmlsaXR5IG9mIGtlZXBpbmcgX3VucHVibGlzaGVkQnVmZmVyIGluIHN5bmMgd2l0aCBfcHVibGlzaGVkXG4gIC8vIGFuZCB0aGUgZWZmZWN0IG9mIGxpbWl0IGVuZm9yY2VkLlxuICBfcmVtb3ZlTWF0Y2hpbmc6IGZ1bmN0aW9uIChpZCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoISBzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKSAmJiAhIHNlbGYuX2xpbWl0KVxuICAgICAgICB0aHJvdyBFcnJvcihcInRyaWVkIHRvIHJlbW92ZSBzb21ldGhpbmcgbWF0Y2hpbmcgYnV0IG5vdCBjYWNoZWQgXCIgKyBpZCk7XG5cbiAgICAgIGlmIChzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKSkge1xuICAgICAgICBzZWxmLl9yZW1vdmVQdWJsaXNoZWQoaWQpO1xuICAgICAgfSBlbHNlIGlmIChzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpKSB7XG4gICAgICAgIHNlbGYuX3JlbW92ZUJ1ZmZlcmVkKGlkKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSxcbiAgX2hhbmRsZURvYzogZnVuY3Rpb24gKGlkLCBuZXdEb2MpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIG1hdGNoZXNOb3cgPSBuZXdEb2MgJiYgc2VsZi5fbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMobmV3RG9jKS5yZXN1bHQ7XG5cbiAgICAgIHZhciBwdWJsaXNoZWRCZWZvcmUgPSBzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKTtcbiAgICAgIHZhciBidWZmZXJlZEJlZm9yZSA9IHNlbGYuX2xpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCk7XG4gICAgICB2YXIgY2FjaGVkQmVmb3JlID0gcHVibGlzaGVkQmVmb3JlIHx8IGJ1ZmZlcmVkQmVmb3JlO1xuXG4gICAgICBpZiAobWF0Y2hlc05vdyAmJiAhY2FjaGVkQmVmb3JlKSB7XG4gICAgICAgIHNlbGYuX2FkZE1hdGNoaW5nKG5ld0RvYyk7XG4gICAgICB9IGVsc2UgaWYgKGNhY2hlZEJlZm9yZSAmJiAhbWF0Y2hlc05vdykge1xuICAgICAgICBzZWxmLl9yZW1vdmVNYXRjaGluZyhpZCk7XG4gICAgICB9IGVsc2UgaWYgKGNhY2hlZEJlZm9yZSAmJiBtYXRjaGVzTm93KSB7XG4gICAgICAgIHZhciBvbGREb2MgPSBzZWxmLl9wdWJsaXNoZWQuZ2V0KGlkKTtcbiAgICAgICAgdmFyIGNvbXBhcmF0b3IgPSBzZWxmLl9jb21wYXJhdG9yO1xuICAgICAgICB2YXIgbWluQnVmZmVyZWQgPSBzZWxmLl9saW1pdCAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgJiZcbiAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5nZXQoc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIubWluRWxlbWVudElkKCkpO1xuICAgICAgICB2YXIgbWF4QnVmZmVyZWQ7XG5cbiAgICAgICAgaWYgKHB1Ymxpc2hlZEJlZm9yZSkge1xuICAgICAgICAgIC8vIFVubGltaXRlZCBjYXNlIHdoZXJlIHRoZSBkb2N1bWVudCBzdGF5cyBpbiBwdWJsaXNoZWQgb25jZSBpdFxuICAgICAgICAgIC8vIG1hdGNoZXMgb3IgdGhlIGNhc2Ugd2hlbiB3ZSBkb24ndCBoYXZlIGVub3VnaCBtYXRjaGluZyBkb2NzIHRvXG4gICAgICAgICAgLy8gcHVibGlzaCBvciB0aGUgY2hhbmdlZCBidXQgbWF0Y2hpbmcgZG9jIHdpbGwgc3RheSBpbiBwdWJsaXNoZWRcbiAgICAgICAgICAvLyBhbnl3YXlzLlxuICAgICAgICAgIC8vXG4gICAgICAgICAgLy8gWFhYOiBXZSByZWx5IG9uIHRoZSBlbXB0aW5lc3Mgb2YgYnVmZmVyLiBCZSBzdXJlIHRvIG1haW50YWluIHRoZVxuICAgICAgICAgIC8vIGZhY3QgdGhhdCBidWZmZXIgY2FuJ3QgYmUgZW1wdHkgaWYgdGhlcmUgYXJlIG1hdGNoaW5nIGRvY3VtZW50cyBub3RcbiAgICAgICAgICAvLyBwdWJsaXNoZWQuIE5vdGFibHksIHdlIGRvbid0IHdhbnQgdG8gc2NoZWR1bGUgcmVwb2xsIGFuZCBjb250aW51ZVxuICAgICAgICAgIC8vIHJlbHlpbmcgb24gdGhpcyBwcm9wZXJ0eS5cbiAgICAgICAgICB2YXIgc3RheXNJblB1Ymxpc2hlZCA9ICEgc2VsZi5fbGltaXQgfHxcbiAgICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSA9PT0gMCB8fFxuICAgICAgICAgICAgY29tcGFyYXRvcihuZXdEb2MsIG1pbkJ1ZmZlcmVkKSA8PSAwO1xuXG4gICAgICAgICAgaWYgKHN0YXlzSW5QdWJsaXNoZWQpIHtcbiAgICAgICAgICAgIHNlbGYuX2NoYW5nZVB1Ymxpc2hlZChpZCwgb2xkRG9jLCBuZXdEb2MpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBhZnRlciB0aGUgY2hhbmdlIGRvYyBkb2Vzbid0IHN0YXkgaW4gdGhlIHB1Ymxpc2hlZCwgcmVtb3ZlIGl0XG4gICAgICAgICAgICBzZWxmLl9yZW1vdmVQdWJsaXNoZWQoaWQpO1xuICAgICAgICAgICAgLy8gYnV0IGl0IGNhbiBtb3ZlIGludG8gYnVmZmVyZWQgbm93LCBjaGVjayBpdFxuICAgICAgICAgICAgbWF4QnVmZmVyZWQgPSBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5nZXQoXG4gICAgICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLm1heEVsZW1lbnRJZCgpKTtcblxuICAgICAgICAgICAgdmFyIHRvQnVmZmVyID0gc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyIHx8XG4gICAgICAgICAgICAgICAgICAobWF4QnVmZmVyZWQgJiYgY29tcGFyYXRvcihuZXdEb2MsIG1heEJ1ZmZlcmVkKSA8PSAwKTtcblxuICAgICAgICAgICAgaWYgKHRvQnVmZmVyKSB7XG4gICAgICAgICAgICAgIHNlbGYuX2FkZEJ1ZmZlcmVkKGlkLCBuZXdEb2MpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgLy8gVGhyb3cgYXdheSBmcm9tIGJvdGggcHVibGlzaGVkIHNldCBhbmQgYnVmZmVyXG4gICAgICAgICAgICAgIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChidWZmZXJlZEJlZm9yZSkge1xuICAgICAgICAgIG9sZERvYyA9IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChpZCk7XG4gICAgICAgICAgLy8gcmVtb3ZlIHRoZSBvbGQgdmVyc2lvbiBtYW51YWxseSBpbnN0ZWFkIG9mIHVzaW5nIF9yZW1vdmVCdWZmZXJlZCBzb1xuICAgICAgICAgIC8vIHdlIGRvbid0IHRyaWdnZXIgdGhlIHF1ZXJ5aW5nIGltbWVkaWF0ZWx5LiAgaWYgd2UgZW5kIHRoaXMgYmxvY2tcbiAgICAgICAgICAvLyB3aXRoIHRoZSBidWZmZXIgZW1wdHksIHdlIHdpbGwgbmVlZCB0byB0cmlnZ2VyIHRoZSBxdWVyeSBwb2xsXG4gICAgICAgICAgLy8gbWFudWFsbHkgdG9vLlxuICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnJlbW92ZShpZCk7XG5cbiAgICAgICAgICB2YXIgbWF4UHVibGlzaGVkID0gc2VsZi5fcHVibGlzaGVkLmdldChcbiAgICAgICAgICAgIHNlbGYuX3B1Ymxpc2hlZC5tYXhFbGVtZW50SWQoKSk7XG4gICAgICAgICAgbWF4QnVmZmVyZWQgPSBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5zaXplKCkgJiZcbiAgICAgICAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5nZXQoXG4gICAgICAgICAgICAgICAgICBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5tYXhFbGVtZW50SWQoKSk7XG5cbiAgICAgICAgICAvLyB0aGUgYnVmZmVyZWQgZG9jIHdhcyB1cGRhdGVkLCBpdCBjb3VsZCBtb3ZlIHRvIHB1Ymxpc2hlZFxuICAgICAgICAgIHZhciB0b1B1Ymxpc2ggPSBjb21wYXJhdG9yKG5ld0RvYywgbWF4UHVibGlzaGVkKSA8IDA7XG5cbiAgICAgICAgICAvLyBvciBzdGF5cyBpbiBidWZmZXIgZXZlbiBhZnRlciB0aGUgY2hhbmdlXG4gICAgICAgICAgdmFyIHN0YXlzSW5CdWZmZXIgPSAoISB0b1B1Ymxpc2ggJiYgc2VsZi5fc2FmZUFwcGVuZFRvQnVmZmVyKSB8fFxuICAgICAgICAgICAgICAgICghdG9QdWJsaXNoICYmIG1heEJ1ZmZlcmVkICYmXG4gICAgICAgICAgICAgICAgIGNvbXBhcmF0b3IobmV3RG9jLCBtYXhCdWZmZXJlZCkgPD0gMCk7XG5cbiAgICAgICAgICBpZiAodG9QdWJsaXNoKSB7XG4gICAgICAgICAgICBzZWxmLl9hZGRQdWJsaXNoZWQoaWQsIG5ld0RvYyk7XG4gICAgICAgICAgfSBlbHNlIGlmIChzdGF5c0luQnVmZmVyKSB7XG4gICAgICAgICAgICAvLyBzdGF5cyBpbiBidWZmZXIgYnV0IGNoYW5nZXNcbiAgICAgICAgICAgIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNldChpZCwgbmV3RG9jKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gVGhyb3cgYXdheSBmcm9tIGJvdGggcHVibGlzaGVkIHNldCBhbmQgYnVmZmVyXG4gICAgICAgICAgICBzZWxmLl9zYWZlQXBwZW5kVG9CdWZmZXIgPSBmYWxzZTtcbiAgICAgICAgICAgIC8vIE5vcm1hbGx5IHRoaXMgY2hlY2sgd291bGQgaGF2ZSBiZWVuIGRvbmUgaW4gX3JlbW92ZUJ1ZmZlcmVkIGJ1dFxuICAgICAgICAgICAgLy8gd2UgZGlkbid0IHVzZSBpdCwgc28gd2UgbmVlZCB0byBkbyBpdCBvdXJzZWxmIG5vdy5cbiAgICAgICAgICAgIGlmICghIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLnNpemUoKSkge1xuICAgICAgICAgICAgICBzZWxmLl9uZWVkVG9Qb2xsUXVlcnkoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiY2FjaGVkQmVmb3JlIGltcGxpZXMgZWl0aGVyIG9mIHB1Ymxpc2hlZEJlZm9yZSBvciBidWZmZXJlZEJlZm9yZSBpcyB0cnVlLlwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICBfZmV0Y2hNb2RpZmllZERvY3VtZW50czogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBzZWxmLl9yZWdpc3RlclBoYXNlQ2hhbmdlKFBIQVNFLkZFVENISU5HKTtcbiAgICAgIC8vIERlZmVyLCBiZWNhdXNlIG5vdGhpbmcgY2FsbGVkIGZyb20gdGhlIG9wbG9nIGVudHJ5IGhhbmRsZXIgbWF5IHlpZWxkLFxuICAgICAgLy8gYnV0IGZldGNoKCkgeWllbGRzLlxuICAgICAgTWV0ZW9yLmRlZmVyKGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgd2hpbGUgKCFzZWxmLl9zdG9wcGVkICYmICFzZWxmLl9uZWVkVG9GZXRjaC5lbXB0eSgpKSB7XG4gICAgICAgICAgaWYgKHNlbGYuX3BoYXNlID09PSBQSEFTRS5RVUVSWUlORykge1xuICAgICAgICAgICAgLy8gV2hpbGUgZmV0Y2hpbmcsIHdlIGRlY2lkZWQgdG8gZ28gaW50byBRVUVSWUlORyBtb2RlLCBhbmQgdGhlbiB3ZVxuICAgICAgICAgICAgLy8gc2F3IGFub3RoZXIgb3Bsb2cgZW50cnksIHNvIF9uZWVkVG9GZXRjaCBpcyBub3QgZW1wdHkuIEJ1dCB3ZVxuICAgICAgICAgICAgLy8gc2hvdWxkbid0IGZldGNoIHRoZXNlIGRvY3VtZW50cyB1bnRpbCBBRlRFUiB0aGUgcXVlcnkgaXMgZG9uZS5cbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIEJlaW5nIGluIHN0ZWFkeSBwaGFzZSBoZXJlIHdvdWxkIGJlIHN1cnByaXNpbmcuXG4gICAgICAgICAgaWYgKHNlbGYuX3BoYXNlICE9PSBQSEFTRS5GRVRDSElORylcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInBoYXNlIGluIGZldGNoTW9kaWZpZWREb2N1bWVudHM6IFwiICsgc2VsZi5fcGhhc2UpO1xuXG4gICAgICAgICAgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcgPSBzZWxmLl9uZWVkVG9GZXRjaDtcbiAgICAgICAgICB2YXIgdGhpc0dlbmVyYXRpb24gPSArK3NlbGYuX2ZldGNoR2VuZXJhdGlvbjtcbiAgICAgICAgICBzZWxmLl9uZWVkVG9GZXRjaCA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgICAgICAgIHZhciB3YWl0aW5nID0gMDtcbiAgICAgICAgICB2YXIgZnV0ID0gbmV3IEZ1dHVyZTtcbiAgICAgICAgICAvLyBUaGlzIGxvb3AgaXMgc2FmZSwgYmVjYXVzZSBfY3VycmVudGx5RmV0Y2hpbmcgd2lsbCBub3QgYmUgdXBkYXRlZFxuICAgICAgICAgIC8vIGR1cmluZyB0aGlzIGxvb3AgKGluIGZhY3QsIGl0IGlzIG5ldmVyIG11dGF0ZWQpLlxuICAgICAgICAgIHNlbGYuX2N1cnJlbnRseUZldGNoaW5nLmZvckVhY2goZnVuY3Rpb24gKGNhY2hlS2V5LCBpZCkge1xuICAgICAgICAgICAgd2FpdGluZysrO1xuICAgICAgICAgICAgc2VsZi5fbW9uZ29IYW5kbGUuX2RvY0ZldGNoZXIuZmV0Y2goXG4gICAgICAgICAgICAgIHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLmNvbGxlY3Rpb25OYW1lLCBpZCwgY2FjaGVLZXksXG4gICAgICAgICAgICAgIGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5KGZ1bmN0aW9uIChlcnIsIGRvYykge1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgICAgICAgICAgIE1ldGVvci5fZGVidWcoXCJHb3QgZXhjZXB0aW9uIHdoaWxlIGZldGNoaW5nIGRvY3VtZW50czogXCIgK1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycik7XG4gICAgICAgICAgICAgICAgICAgIC8vIElmIHdlIGdldCBhbiBlcnJvciBmcm9tIHRoZSBmZXRjaGVyIChlZywgdHJvdWJsZVxuICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0aW5nIHRvIE1vbmdvKSwgbGV0J3MganVzdCBhYmFuZG9uIHRoZSBmZXRjaCBwaGFzZVxuICAgICAgICAgICAgICAgICAgICAvLyBhbHRvZ2V0aGVyIGFuZCBmYWxsIGJhY2sgdG8gcG9sbGluZy4gSXQncyBub3QgbGlrZSB3ZSdyZVxuICAgICAgICAgICAgICAgICAgICAvLyBnZXR0aW5nIGxpdmUgdXBkYXRlcyBhbnl3YXkuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzZWxmLl9waGFzZSAhPT0gUEhBU0UuUVVFUllJTkcpIHtcbiAgICAgICAgICAgICAgICAgICAgICBzZWxmLl9uZWVkVG9Qb2xsUXVlcnkoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmICghc2VsZi5fc3RvcHBlZCAmJiBzZWxmLl9waGFzZSA9PT0gUEhBU0UuRkVUQ0hJTkdcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJiYgc2VsZi5fZmV0Y2hHZW5lcmF0aW9uID09PSB0aGlzR2VuZXJhdGlvbikge1xuICAgICAgICAgICAgICAgICAgICAvLyBXZSByZS1jaGVjayB0aGUgZ2VuZXJhdGlvbiBpbiBjYXNlIHdlJ3ZlIGhhZCBhbiBleHBsaWNpdFxuICAgICAgICAgICAgICAgICAgICAvLyBfcG9sbFF1ZXJ5IGNhbGwgKGVnLCBpbiBhbm90aGVyIGZpYmVyKSB3aGljaCBzaG91bGRcbiAgICAgICAgICAgICAgICAgICAgLy8gZWZmZWN0aXZlbHkgY2FuY2VsIHRoaXMgcm91bmQgb2YgZmV0Y2hlcy4gIChfcG9sbFF1ZXJ5XG4gICAgICAgICAgICAgICAgICAgIC8vIGluY3JlbWVudHMgdGhlIGdlbmVyYXRpb24uKVxuICAgICAgICAgICAgICAgICAgICBzZWxmLl9oYW5kbGVEb2MoaWQsIGRvYyk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgICAgIHdhaXRpbmctLTtcbiAgICAgICAgICAgICAgICAgIC8vIEJlY2F1c2UgZmV0Y2goKSBuZXZlciBjYWxscyBpdHMgY2FsbGJhY2sgc3luY2hyb25vdXNseSxcbiAgICAgICAgICAgICAgICAgIC8vIHRoaXMgaXMgc2FmZSAoaWUsIHdlIHdvbid0IGNhbGwgZnV0LnJldHVybigpIGJlZm9yZSB0aGVcbiAgICAgICAgICAgICAgICAgIC8vIGZvckVhY2ggaXMgZG9uZSkuXG4gICAgICAgICAgICAgICAgICBpZiAod2FpdGluZyA9PT0gMClcbiAgICAgICAgICAgICAgICAgICAgZnV0LnJldHVybigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIGZ1dC53YWl0KCk7XG4gICAgICAgICAgLy8gRXhpdCBub3cgaWYgd2UndmUgaGFkIGEgX3BvbGxRdWVyeSBjYWxsIChoZXJlIG9yIGluIGFub3RoZXIgZmliZXIpLlxuICAgICAgICAgIGlmIChzZWxmLl9waGFzZSA9PT0gUEhBU0UuUVVFUllJTkcpXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIC8vIFdlJ3JlIGRvbmUgZmV0Y2hpbmcsIHNvIHdlIGNhbiBiZSBzdGVhZHksIHVubGVzcyB3ZSd2ZSBoYWQgYVxuICAgICAgICAvLyBfcG9sbFF1ZXJ5IGNhbGwgKGhlcmUgb3IgaW4gYW5vdGhlciBmaWJlcikuXG4gICAgICAgIGlmIChzZWxmLl9waGFzZSAhPT0gUEhBU0UuUVVFUllJTkcpXG4gICAgICAgICAgc2VsZi5fYmVTdGVhZHkoKTtcbiAgICAgIH0pKTtcbiAgICB9KTtcbiAgfSxcbiAgX2JlU3RlYWR5OiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX3JlZ2lzdGVyUGhhc2VDaGFuZ2UoUEhBU0UuU1RFQURZKTtcbiAgICAgIHZhciB3cml0ZXMgPSBzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5O1xuICAgICAgc2VsZi5fd3JpdGVzVG9Db21taXRXaGVuV2VSZWFjaFN0ZWFkeSA9IFtdO1xuICAgICAgc2VsZi5fbXVsdGlwbGV4ZXIub25GbHVzaChmdW5jdGlvbiAoKSB7XG4gICAgICAgIF8uZWFjaCh3cml0ZXMsIGZ1bmN0aW9uICh3KSB7XG4gICAgICAgICAgdy5jb21taXR0ZWQoKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcbiAgX2hhbmRsZU9wbG9nRW50cnlRdWVyeWluZzogZnVuY3Rpb24gKG9wKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHNlbGYuX25lZWRUb0ZldGNoLnNldChpZEZvck9wKG9wKSwgb3AudHMudG9TdHJpbmcoKSk7XG4gICAgfSk7XG4gIH0sXG4gIF9oYW5kbGVPcGxvZ0VudHJ5U3RlYWR5T3JGZXRjaGluZzogZnVuY3Rpb24gKG9wKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBpZCA9IGlkRm9yT3Aob3ApO1xuICAgICAgLy8gSWYgd2UncmUgYWxyZWFkeSBmZXRjaGluZyB0aGlzIG9uZSwgb3IgYWJvdXQgdG8sIHdlIGNhbid0IG9wdGltaXplO1xuICAgICAgLy8gbWFrZSBzdXJlIHRoYXQgd2UgZmV0Y2ggaXQgYWdhaW4gaWYgbmVjZXNzYXJ5LlxuICAgICAgaWYgKHNlbGYuX3BoYXNlID09PSBQSEFTRS5GRVRDSElORyAmJlxuICAgICAgICAgICgoc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcgJiYgc2VsZi5fY3VycmVudGx5RmV0Y2hpbmcuaGFzKGlkKSkgfHxcbiAgICAgICAgICAgc2VsZi5fbmVlZFRvRmV0Y2guaGFzKGlkKSkpIHtcbiAgICAgICAgc2VsZi5fbmVlZFRvRmV0Y2guc2V0KGlkLCBvcC50cy50b1N0cmluZygpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAob3Aub3AgPT09ICdkJykge1xuICAgICAgICBpZiAoc2VsZi5fcHVibGlzaGVkLmhhcyhpZCkgfHxcbiAgICAgICAgICAgIChzZWxmLl9saW1pdCAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpKSlcbiAgICAgICAgICBzZWxmLl9yZW1vdmVNYXRjaGluZyhpZCk7XG4gICAgICB9IGVsc2UgaWYgKG9wLm9wID09PSAnaScpIHtcbiAgICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5oYXMoaWQpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImluc2VydCBmb3VuZCBmb3IgYWxyZWFkeS1leGlzdGluZyBJRCBpbiBwdWJsaXNoZWRcIik7XG4gICAgICAgIGlmIChzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlciAmJiBzZWxmLl91bnB1Ymxpc2hlZEJ1ZmZlci5oYXMoaWQpKVxuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImluc2VydCBmb3VuZCBmb3IgYWxyZWFkeS1leGlzdGluZyBJRCBpbiBidWZmZXJcIik7XG5cbiAgICAgICAgLy8gWFhYIHdoYXQgaWYgc2VsZWN0b3IgeWllbGRzPyAgZm9yIG5vdyBpdCBjYW4ndCBidXQgbGF0ZXIgaXQgY291bGRcbiAgICAgICAgLy8gaGF2ZSAkd2hlcmVcbiAgICAgICAgaWYgKHNlbGYuX21hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKG9wLm8pLnJlc3VsdClcbiAgICAgICAgICBzZWxmLl9hZGRNYXRjaGluZyhvcC5vKTtcbiAgICAgIH0gZWxzZSBpZiAob3Aub3AgPT09ICd1Jykge1xuICAgICAgICAvLyBJcyB0aGlzIGEgbW9kaWZpZXIgKCRzZXQvJHVuc2V0LCB3aGljaCBtYXkgcmVxdWlyZSB1cyB0byBwb2xsIHRoZVxuICAgICAgICAvLyBkYXRhYmFzZSB0byBmaWd1cmUgb3V0IGlmIHRoZSB3aG9sZSBkb2N1bWVudCBtYXRjaGVzIHRoZSBzZWxlY3Rvcikgb3JcbiAgICAgICAgLy8gYSByZXBsYWNlbWVudCAoaW4gd2hpY2ggY2FzZSB3ZSBjYW4ganVzdCBkaXJlY3RseSByZS1ldmFsdWF0ZSB0aGVcbiAgICAgICAgLy8gc2VsZWN0b3IpP1xuICAgICAgICB2YXIgaXNSZXBsYWNlID0gIV8uaGFzKG9wLm8sICckc2V0JykgJiYgIV8uaGFzKG9wLm8sICckdW5zZXQnKTtcbiAgICAgICAgLy8gSWYgdGhpcyBtb2RpZmllciBtb2RpZmllcyBzb21ldGhpbmcgaW5zaWRlIGFuIEVKU09OIGN1c3RvbSB0eXBlIChpZSxcbiAgICAgICAgLy8gYW55dGhpbmcgd2l0aCBFSlNPTiQpLCB0aGVuIHdlIGNhbid0IHRyeSB0byB1c2VcbiAgICAgICAgLy8gTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnksIHNpbmNlIHRoYXQganVzdCBtdXRhdGVzIHRoZSBFSlNPTiBlbmNvZGluZyxcbiAgICAgICAgLy8gbm90IHRoZSBhY3R1YWwgb2JqZWN0LlxuICAgICAgICB2YXIgY2FuRGlyZWN0bHlNb2RpZnlEb2MgPVxuICAgICAgICAgICFpc1JlcGxhY2UgJiYgbW9kaWZpZXJDYW5CZURpcmVjdGx5QXBwbGllZChvcC5vKTtcblxuICAgICAgICB2YXIgcHVibGlzaGVkQmVmb3JlID0gc2VsZi5fcHVibGlzaGVkLmhhcyhpZCk7XG4gICAgICAgIHZhciBidWZmZXJlZEJlZm9yZSA9IHNlbGYuX2xpbWl0ICYmIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmhhcyhpZCk7XG5cbiAgICAgICAgaWYgKGlzUmVwbGFjZSkge1xuICAgICAgICAgIHNlbGYuX2hhbmRsZURvYyhpZCwgXy5leHRlbmQoe19pZDogaWR9LCBvcC5vKSk7XG4gICAgICAgIH0gZWxzZSBpZiAoKHB1Ymxpc2hlZEJlZm9yZSB8fCBidWZmZXJlZEJlZm9yZSkgJiZcbiAgICAgICAgICAgICAgICAgICBjYW5EaXJlY3RseU1vZGlmeURvYykge1xuICAgICAgICAgIC8vIE9oIGdyZWF0LCB3ZSBhY3R1YWxseSBrbm93IHdoYXQgdGhlIGRvY3VtZW50IGlzLCBzbyB3ZSBjYW4gYXBwbHlcbiAgICAgICAgICAvLyB0aGlzIGRpcmVjdGx5LlxuICAgICAgICAgIHZhciBuZXdEb2MgPSBzZWxmLl9wdWJsaXNoZWQuaGFzKGlkKVxuICAgICAgICAgICAgPyBzZWxmLl9wdWJsaXNoZWQuZ2V0KGlkKSA6IHNlbGYuX3VucHVibGlzaGVkQnVmZmVyLmdldChpZCk7XG4gICAgICAgICAgbmV3RG9jID0gRUpTT04uY2xvbmUobmV3RG9jKTtcblxuICAgICAgICAgIG5ld0RvYy5faWQgPSBpZDtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkobmV3RG9jLCBvcC5vKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBpZiAoZS5uYW1lICE9PSBcIk1pbmltb25nb0Vycm9yXCIpXG4gICAgICAgICAgICAgIHRocm93IGU7XG4gICAgICAgICAgICAvLyBXZSBkaWRuJ3QgdW5kZXJzdGFuZCB0aGUgbW9kaWZpZXIuICBSZS1mZXRjaC5cbiAgICAgICAgICAgIHNlbGYuX25lZWRUb0ZldGNoLnNldChpZCwgb3AudHMudG9TdHJpbmcoKSk7XG4gICAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLlNURUFEWSkge1xuICAgICAgICAgICAgICBzZWxmLl9mZXRjaE1vZGlmaWVkRG9jdW1lbnRzKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHNlbGYuX2hhbmRsZURvYyhpZCwgc2VsZi5fc2hhcmVkUHJvamVjdGlvbkZuKG5ld0RvYykpO1xuICAgICAgICB9IGVsc2UgaWYgKCFjYW5EaXJlY3RseU1vZGlmeURvYyB8fFxuICAgICAgICAgICAgICAgICAgIHNlbGYuX21hdGNoZXIuY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIob3AubykgfHxcbiAgICAgICAgICAgICAgICAgICAoc2VsZi5fc29ydGVyICYmIHNlbGYuX3NvcnRlci5hZmZlY3RlZEJ5TW9kaWZpZXIob3AubykpKSB7XG4gICAgICAgICAgc2VsZi5fbmVlZFRvRmV0Y2guc2V0KGlkLCBvcC50cy50b1N0cmluZygpKTtcbiAgICAgICAgICBpZiAoc2VsZi5fcGhhc2UgPT09IFBIQVNFLlNURUFEWSlcbiAgICAgICAgICAgIHNlbGYuX2ZldGNoTW9kaWZpZWREb2N1bWVudHMoKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoXCJYWFggU1VSUFJJU0lORyBPUEVSQVRJT046IFwiICsgb3ApO1xuICAgICAgfVxuICAgIH0pO1xuICB9LFxuICAvLyBZaWVsZHMhXG4gIF9ydW5Jbml0aWFsUXVlcnk6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJvcGxvZyBzdG9wcGVkIHN1cnByaXNpbmdseSBlYXJseVwiKTtcblxuICAgIHNlbGYuX3J1blF1ZXJ5KHtpbml0aWFsOiB0cnVlfSk7ICAvLyB5aWVsZHNcblxuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuOyAgLy8gY2FuIGhhcHBlbiBvbiBxdWVyeUVycm9yXG5cbiAgICAvLyBBbGxvdyBvYnNlcnZlQ2hhbmdlcyBjYWxscyB0byByZXR1cm4uIChBZnRlciB0aGlzLCBpdCdzIHBvc3NpYmxlIGZvclxuICAgIC8vIHN0b3AoKSB0byBiZSBjYWxsZWQuKVxuICAgIHNlbGYuX211bHRpcGxleGVyLnJlYWR5KCk7XG5cbiAgICBzZWxmLl9kb25lUXVlcnlpbmcoKTsgIC8vIHlpZWxkc1xuICB9LFxuXG4gIC8vIEluIHZhcmlvdXMgY2lyY3Vtc3RhbmNlcywgd2UgbWF5IGp1c3Qgd2FudCB0byBzdG9wIHByb2Nlc3NpbmcgdGhlIG9wbG9nIGFuZFxuICAvLyByZS1ydW4gdGhlIGluaXRpYWwgcXVlcnksIGp1c3QgYXMgaWYgd2Ugd2VyZSBhIFBvbGxpbmdPYnNlcnZlRHJpdmVyLlxuICAvL1xuICAvLyBUaGlzIGZ1bmN0aW9uIG1heSBub3QgYmxvY2ssIGJlY2F1c2UgaXQgaXMgY2FsbGVkIGZyb20gYW4gb3Bsb2cgZW50cnlcbiAgLy8gaGFuZGxlci5cbiAgLy9cbiAgLy8gWFhYIFdlIHNob3VsZCBjYWxsIHRoaXMgd2hlbiB3ZSBkZXRlY3QgdGhhdCB3ZSd2ZSBiZWVuIGluIEZFVENISU5HIGZvciBcInRvb1xuICAvLyBsb25nXCIuXG4gIC8vXG4gIC8vIFhYWCBXZSBzaG91bGQgY2FsbCB0aGlzIHdoZW4gd2UgZGV0ZWN0IE1vbmdvIGZhaWxvdmVyIChzaW5jZSB0aGF0IG1pZ2h0XG4gIC8vIG1lYW4gdGhhdCBzb21lIG9mIHRoZSBvcGxvZyBlbnRyaWVzIHdlIGhhdmUgcHJvY2Vzc2VkIGhhdmUgYmVlbiByb2xsZWRcbiAgLy8gYmFjaykuIFRoZSBOb2RlIE1vbmdvIGRyaXZlciBpcyBpbiB0aGUgbWlkZGxlIG9mIGEgYnVuY2ggb2YgaHVnZVxuICAvLyByZWZhY3RvcmluZ3MsIGluY2x1ZGluZyB0aGUgd2F5IHRoYXQgaXQgbm90aWZpZXMgeW91IHdoZW4gcHJpbWFyeVxuICAvLyBjaGFuZ2VzLiBXaWxsIHB1dCBvZmYgaW1wbGVtZW50aW5nIHRoaXMgdW50aWwgZHJpdmVyIDEuNCBpcyBvdXQuXG4gIF9wb2xsUXVlcnk6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICAgIHJldHVybjtcblxuICAgICAgLy8gWWF5LCB3ZSBnZXQgdG8gZm9yZ2V0IGFib3V0IGFsbCB0aGUgdGhpbmdzIHdlIHRob3VnaHQgd2UgaGFkIHRvIGZldGNoLlxuICAgICAgc2VsZi5fbmVlZFRvRmV0Y2ggPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICAgIHNlbGYuX2N1cnJlbnRseUZldGNoaW5nID0gbnVsbDtcbiAgICAgICsrc2VsZi5fZmV0Y2hHZW5lcmF0aW9uOyAgLy8gaWdub3JlIGFueSBpbi1mbGlnaHQgZmV0Y2hlc1xuICAgICAgc2VsZi5fcmVnaXN0ZXJQaGFzZUNoYW5nZShQSEFTRS5RVUVSWUlORyk7XG5cbiAgICAgIC8vIERlZmVyIHNvIHRoYXQgd2UgZG9uJ3QgeWllbGQuICBXZSBkb24ndCBuZWVkIGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5XG4gICAgICAvLyBoZXJlIGJlY2F1c2UgU3dpdGNoZWRUb1F1ZXJ5IGlzIG5vdCB0aHJvd24gaW4gUVVFUllJTkcgbW9kZS5cbiAgICAgIE1ldGVvci5kZWZlcihmdW5jdGlvbiAoKSB7XG4gICAgICAgIHNlbGYuX3J1blF1ZXJ5KCk7XG4gICAgICAgIHNlbGYuX2RvbmVRdWVyeWluZygpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgLy8gWWllbGRzIVxuICBfcnVuUXVlcnk6IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICAgIHZhciBuZXdSZXN1bHRzLCBuZXdCdWZmZXI7XG5cbiAgICAvLyBUaGlzIHdoaWxlIGxvb3AgaXMganVzdCB0byByZXRyeSBmYWlsdXJlcy5cbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgLy8gSWYgd2UndmUgYmVlbiBzdG9wcGVkLCB3ZSBkb24ndCBoYXZlIHRvIHJ1biBhbnl0aGluZyBhbnkgbW9yZS5cbiAgICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgICByZXR1cm47XG5cbiAgICAgIG5ld1Jlc3VsdHMgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICAgIG5ld0J1ZmZlciA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuXG4gICAgICAvLyBRdWVyeSAyeCBkb2N1bWVudHMgYXMgdGhlIGhhbGYgZXhjbHVkZWQgZnJvbSB0aGUgb3JpZ2luYWwgcXVlcnkgd2lsbCBnb1xuICAgICAgLy8gaW50byB1bnB1Ymxpc2hlZCBidWZmZXIgdG8gcmVkdWNlIGFkZGl0aW9uYWwgTW9uZ28gbG9va3VwcyBpbiBjYXNlc1xuICAgICAgLy8gd2hlbiBkb2N1bWVudHMgYXJlIHJlbW92ZWQgZnJvbSB0aGUgcHVibGlzaGVkIHNldCBhbmQgbmVlZCBhXG4gICAgICAvLyByZXBsYWNlbWVudC5cbiAgICAgIC8vIFhYWCBuZWVkcyBtb3JlIHRob3VnaHQgb24gbm9uLXplcm8gc2tpcFxuICAgICAgLy8gWFhYIDIgaXMgYSBcIm1hZ2ljIG51bWJlclwiIG1lYW5pbmcgdGhlcmUgaXMgYW4gZXh0cmEgY2h1bmsgb2YgZG9jcyBmb3JcbiAgICAgIC8vIGJ1ZmZlciBpZiBzdWNoIGlzIG5lZWRlZC5cbiAgICAgIHZhciBjdXJzb3IgPSBzZWxmLl9jdXJzb3JGb3JRdWVyeSh7IGxpbWl0OiBzZWxmLl9saW1pdCAqIDIgfSk7XG4gICAgICB0cnkge1xuICAgICAgICBjdXJzb3IuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpKSB7ICAvLyB5aWVsZHNcbiAgICAgICAgICBpZiAoIXNlbGYuX2xpbWl0IHx8IGkgPCBzZWxmLl9saW1pdCkge1xuICAgICAgICAgICAgbmV3UmVzdWx0cy5zZXQoZG9jLl9pZCwgZG9jKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbmV3QnVmZmVyLnNldChkb2MuX2lkLCBkb2MpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAob3B0aW9ucy5pbml0aWFsICYmIHR5cGVvZihlLmNvZGUpID09PSAnbnVtYmVyJykge1xuICAgICAgICAgIC8vIFRoaXMgaXMgYW4gZXJyb3IgZG9jdW1lbnQgc2VudCB0byB1cyBieSBtb25nb2QsIG5vdCBhIGNvbm5lY3Rpb25cbiAgICAgICAgICAvLyBlcnJvciBnZW5lcmF0ZWQgYnkgdGhlIGNsaWVudC4gQW5kIHdlJ3ZlIG5ldmVyIHNlZW4gdGhpcyBxdWVyeSB3b3JrXG4gICAgICAgICAgLy8gc3VjY2Vzc2Z1bGx5LiBQcm9iYWJseSBpdCdzIGEgYmFkIHNlbGVjdG9yIG9yIHNvbWV0aGluZywgc28gd2VcbiAgICAgICAgICAvLyBzaG91bGQgTk9UIHJldHJ5LiBJbnN0ZWFkLCB3ZSBzaG91bGQgaGFsdCB0aGUgb2JzZXJ2ZSAod2hpY2ggZW5kc1xuICAgICAgICAgIC8vIHVwIGNhbGxpbmcgYHN0b3BgIG9uIHVzKS5cbiAgICAgICAgICBzZWxmLl9tdWx0aXBsZXhlci5xdWVyeUVycm9yKGUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIER1cmluZyBmYWlsb3ZlciAoZWcpIGlmIHdlIGdldCBhbiBleGNlcHRpb24gd2Ugc2hvdWxkIGxvZyBhbmQgcmV0cnlcbiAgICAgICAgLy8gaW5zdGVhZCBvZiBjcmFzaGluZy5cbiAgICAgICAgTWV0ZW9yLl9kZWJ1ZyhcIkdvdCBleGNlcHRpb24gd2hpbGUgcG9sbGluZyBxdWVyeTogXCIgKyBlKTtcbiAgICAgICAgTWV0ZW9yLl9zbGVlcEZvck1zKDEwMCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHNlbGYuX3N0b3BwZWQpXG4gICAgICByZXR1cm47XG5cbiAgICBzZWxmLl9wdWJsaXNoTmV3UmVzdWx0cyhuZXdSZXN1bHRzLCBuZXdCdWZmZXIpO1xuICB9LFxuXG4gIC8vIFRyYW5zaXRpb25zIHRvIFFVRVJZSU5HIGFuZCBydW5zIGFub3RoZXIgcXVlcnksIG9yIChpZiBhbHJlYWR5IGluIFFVRVJZSU5HKVxuICAvLyBlbnN1cmVzIHRoYXQgd2Ugd2lsbCBxdWVyeSBhZ2FpbiBsYXRlci5cbiAgLy9cbiAgLy8gVGhpcyBmdW5jdGlvbiBtYXkgbm90IGJsb2NrLCBiZWNhdXNlIGl0IGlzIGNhbGxlZCBmcm9tIGFuIG9wbG9nIGVudHJ5XG4gIC8vIGhhbmRsZXIuIEhvd2V2ZXIsIGlmIHdlIHdlcmUgbm90IGFscmVhZHkgaW4gdGhlIFFVRVJZSU5HIHBoYXNlLCBpdCB0aHJvd3NcbiAgLy8gYW4gZXhjZXB0aW9uIHRoYXQgaXMgY2F1Z2h0IGJ5IHRoZSBjbG9zZXN0IHN1cnJvdW5kaW5nXG4gIC8vIGZpbmlzaElmTmVlZFRvUG9sbFF1ZXJ5IGNhbGw7IHRoaXMgZW5zdXJlcyB0aGF0IHdlIGRvbid0IGNvbnRpbnVlIHJ1bm5pbmdcbiAgLy8gY2xvc2UgdGhhdCB3YXMgZGVzaWduZWQgZm9yIGFub3RoZXIgcGhhc2UgaW5zaWRlIFBIQVNFLlFVRVJZSU5HLlxuICAvL1xuICAvLyAoSXQncyBhbHNvIG5lY2Vzc2FyeSB3aGVuZXZlciBsb2dpYyBpbiB0aGlzIGZpbGUgeWllbGRzIHRvIGNoZWNrIHRoYXQgb3RoZXJcbiAgLy8gcGhhc2VzIGhhdmVuJ3QgcHV0IHVzIGludG8gUVVFUllJTkcgbW9kZSwgdGhvdWdoOyBlZyxcbiAgLy8gX2ZldGNoTW9kaWZpZWREb2N1bWVudHMgZG9lcyB0aGlzLilcbiAgX25lZWRUb1BvbGxRdWVyeTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgICAgcmV0dXJuO1xuXG4gICAgICAvLyBJZiB3ZSdyZSBub3QgYWxyZWFkeSBpbiB0aGUgbWlkZGxlIG9mIGEgcXVlcnksIHdlIGNhbiBxdWVyeSBub3dcbiAgICAgIC8vIChwb3NzaWJseSBwYXVzaW5nIEZFVENISU5HKS5cbiAgICAgIGlmIChzZWxmLl9waGFzZSAhPT0gUEhBU0UuUVVFUllJTkcpIHtcbiAgICAgICAgc2VsZi5fcG9sbFF1ZXJ5KCk7XG4gICAgICAgIHRocm93IG5ldyBTd2l0Y2hlZFRvUXVlcnk7XG4gICAgICB9XG5cbiAgICAgIC8vIFdlJ3JlIGN1cnJlbnRseSBpbiBRVUVSWUlORy4gU2V0IGEgZmxhZyB0byBlbnN1cmUgdGhhdCB3ZSBydW4gYW5vdGhlclxuICAgICAgLy8gcXVlcnkgd2hlbiB3ZSdyZSBkb25lLlxuICAgICAgc2VsZi5fcmVxdWVyeVdoZW5Eb25lVGhpc1F1ZXJ5ID0gdHJ1ZTtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBZaWVsZHMhXG4gIF9kb25lUXVlcnlpbmc6IGZ1bmN0aW9uICgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG5cbiAgICBpZiAoc2VsZi5fc3RvcHBlZClcbiAgICAgIHJldHVybjtcbiAgICBzZWxmLl9tb25nb0hhbmRsZS5fb3Bsb2dIYW5kbGUud2FpdFVudGlsQ2F1Z2h0VXAoKTsgIC8vIHlpZWxkc1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuICAgIGlmIChzZWxmLl9waGFzZSAhPT0gUEhBU0UuUVVFUllJTkcpXG4gICAgICB0aHJvdyBFcnJvcihcIlBoYXNlIHVuZXhwZWN0ZWRseSBcIiArIHNlbGYuX3BoYXNlKTtcblxuICAgIE1ldGVvci5fbm9ZaWVsZHNBbGxvd2VkKGZ1bmN0aW9uICgpIHtcbiAgICAgIGlmIChzZWxmLl9yZXF1ZXJ5V2hlbkRvbmVUaGlzUXVlcnkpIHtcbiAgICAgICAgc2VsZi5fcmVxdWVyeVdoZW5Eb25lVGhpc1F1ZXJ5ID0gZmFsc2U7XG4gICAgICAgIHNlbGYuX3BvbGxRdWVyeSgpO1xuICAgICAgfSBlbHNlIGlmIChzZWxmLl9uZWVkVG9GZXRjaC5lbXB0eSgpKSB7XG4gICAgICAgIHNlbGYuX2JlU3RlYWR5KCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWxmLl9mZXRjaE1vZGlmaWVkRG9jdW1lbnRzKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0sXG5cbiAgX2N1cnNvckZvclF1ZXJ5OiBmdW5jdGlvbiAob3B0aW9uc092ZXJ3cml0ZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICByZXR1cm4gTWV0ZW9yLl9ub1lpZWxkc0FsbG93ZWQoZnVuY3Rpb24gKCkge1xuICAgICAgLy8gVGhlIHF1ZXJ5IHdlIHJ1biBpcyBhbG1vc3QgdGhlIHNhbWUgYXMgdGhlIGN1cnNvciB3ZSBhcmUgb2JzZXJ2aW5nLFxuICAgICAgLy8gd2l0aCBhIGZldyBjaGFuZ2VzLiBXZSBuZWVkIHRvIHJlYWQgYWxsIHRoZSBmaWVsZHMgdGhhdCBhcmUgcmVsZXZhbnQgdG9cbiAgICAgIC8vIHRoZSBzZWxlY3Rvciwgbm90IGp1c3QgdGhlIGZpZWxkcyB3ZSBhcmUgZ29pbmcgdG8gcHVibGlzaCAodGhhdCdzIHRoZVxuICAgICAgLy8gXCJzaGFyZWRcIiBwcm9qZWN0aW9uKS4gQW5kIHdlIGRvbid0IHdhbnQgdG8gYXBwbHkgYW55IHRyYW5zZm9ybSBpbiB0aGVcbiAgICAgIC8vIGN1cnNvciwgYmVjYXVzZSBvYnNlcnZlQ2hhbmdlcyBzaG91bGRuJ3QgdXNlIHRoZSB0cmFuc2Zvcm0uXG4gICAgICB2YXIgb3B0aW9ucyA9IF8uY2xvbmUoc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucyk7XG5cbiAgICAgIC8vIEFsbG93IHRoZSBjYWxsZXIgdG8gbW9kaWZ5IHRoZSBvcHRpb25zLiBVc2VmdWwgdG8gc3BlY2lmeSBkaWZmZXJlbnRcbiAgICAgIC8vIHNraXAgYW5kIGxpbWl0IHZhbHVlcy5cbiAgICAgIF8uZXh0ZW5kKG9wdGlvbnMsIG9wdGlvbnNPdmVyd3JpdGUpO1xuXG4gICAgICBvcHRpb25zLmZpZWxkcyA9IHNlbGYuX3NoYXJlZFByb2plY3Rpb247XG4gICAgICBkZWxldGUgb3B0aW9ucy50cmFuc2Zvcm07XG4gICAgICAvLyBXZSBhcmUgTk9UIGRlZXAgY2xvbmluZyBmaWVsZHMgb3Igc2VsZWN0b3IgaGVyZSwgd2hpY2ggc2hvdWxkIGJlIE9LLlxuICAgICAgdmFyIGRlc2NyaXB0aW9uID0gbmV3IEN1cnNvckRlc2NyaXB0aW9uKFxuICAgICAgICBzZWxmLl9jdXJzb3JEZXNjcmlwdGlvbi5jb2xsZWN0aW9uTmFtZSxcbiAgICAgICAgc2VsZi5fY3Vyc29yRGVzY3JpcHRpb24uc2VsZWN0b3IsXG4gICAgICAgIG9wdGlvbnMpO1xuICAgICAgcmV0dXJuIG5ldyBDdXJzb3Ioc2VsZi5fbW9uZ29IYW5kbGUsIGRlc2NyaXB0aW9uKTtcbiAgICB9KTtcbiAgfSxcblxuXG4gIC8vIFJlcGxhY2Ugc2VsZi5fcHVibGlzaGVkIHdpdGggbmV3UmVzdWx0cyAoYm90aCBhcmUgSWRNYXBzKSwgaW52b2tpbmcgb2JzZXJ2ZVxuICAvLyBjYWxsYmFja3Mgb24gdGhlIG11bHRpcGxleGVyLlxuICAvLyBSZXBsYWNlIHNlbGYuX3VucHVibGlzaGVkQnVmZmVyIHdpdGggbmV3QnVmZmVyLlxuICAvL1xuICAvLyBYWFggVGhpcyBpcyB2ZXJ5IHNpbWlsYXIgdG8gTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzLiBXZVxuICAvLyBzaG91bGQgcmVhbGx5OiAoYSkgVW5pZnkgSWRNYXAgYW5kIE9yZGVyZWREaWN0IGludG8gVW5vcmRlcmVkL09yZGVyZWREaWN0XG4gIC8vIChiKSBSZXdyaXRlIGRpZmYuanMgdG8gdXNlIHRoZXNlIGNsYXNzZXMgaW5zdGVhZCBvZiBhcnJheXMgYW5kIG9iamVjdHMuXG4gIF9wdWJsaXNoTmV3UmVzdWx0czogZnVuY3Rpb24gKG5ld1Jlc3VsdHMsIG5ld0J1ZmZlcikge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG5cbiAgICAgIC8vIElmIHRoZSBxdWVyeSBpcyBsaW1pdGVkIGFuZCB0aGVyZSBpcyBhIGJ1ZmZlciwgc2h1dCBkb3duIHNvIGl0IGRvZXNuJ3RcbiAgICAgIC8vIHN0YXkgaW4gYSB3YXkuXG4gICAgICBpZiAoc2VsZi5fbGltaXQpIHtcbiAgICAgICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIuY2xlYXIoKTtcbiAgICAgIH1cblxuICAgICAgLy8gRmlyc3QgcmVtb3ZlIGFueXRoaW5nIHRoYXQncyBnb25lLiBCZSBjYXJlZnVsIG5vdCB0byBtb2RpZnlcbiAgICAgIC8vIHNlbGYuX3B1Ymxpc2hlZCB3aGlsZSBpdGVyYXRpbmcgb3ZlciBpdC5cbiAgICAgIHZhciBpZHNUb1JlbW92ZSA9IFtdO1xuICAgICAgc2VsZi5fcHVibGlzaGVkLmZvckVhY2goZnVuY3Rpb24gKGRvYywgaWQpIHtcbiAgICAgICAgaWYgKCFuZXdSZXN1bHRzLmhhcyhpZCkpXG4gICAgICAgICAgaWRzVG9SZW1vdmUucHVzaChpZCk7XG4gICAgICB9KTtcbiAgICAgIF8uZWFjaChpZHNUb1JlbW92ZSwgZnVuY3Rpb24gKGlkKSB7XG4gICAgICAgIHNlbGYuX3JlbW92ZVB1Ymxpc2hlZChpZCk7XG4gICAgICB9KTtcblxuICAgICAgLy8gTm93IGRvIGFkZHMgYW5kIGNoYW5nZXMuXG4gICAgICAvLyBJZiBzZWxmIGhhcyBhIGJ1ZmZlciBhbmQgbGltaXQsIHRoZSBuZXcgZmV0Y2hlZCByZXN1bHQgd2lsbCBiZVxuICAgICAgLy8gbGltaXRlZCBjb3JyZWN0bHkgYXMgdGhlIHF1ZXJ5IGhhcyBzb3J0IHNwZWNpZmllci5cbiAgICAgIG5ld1Jlc3VsdHMuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpZCkge1xuICAgICAgICBzZWxmLl9oYW5kbGVEb2MoaWQsIGRvYyk7XG4gICAgICB9KTtcblxuICAgICAgLy8gU2FuaXR5LWNoZWNrIHRoYXQgZXZlcnl0aGluZyB3ZSB0cmllZCB0byBwdXQgaW50byBfcHVibGlzaGVkIGVuZGVkIHVwXG4gICAgICAvLyB0aGVyZS5cbiAgICAgIC8vIFhYWCBpZiB0aGlzIGlzIHNsb3csIHJlbW92ZSBpdCBsYXRlclxuICAgICAgaWYgKHNlbGYuX3B1Ymxpc2hlZC5zaXplKCkgIT09IG5ld1Jlc3VsdHMuc2l6ZSgpKSB7XG4gICAgICAgIHRocm93IEVycm9yKFxuICAgICAgICAgIFwiVGhlIE1vbmdvIHNlcnZlciBhbmQgdGhlIE1ldGVvciBxdWVyeSBkaXNhZ3JlZSBvbiBob3cgXCIgK1xuICAgICAgICAgICAgXCJtYW55IGRvY3VtZW50cyBtYXRjaCB5b3VyIHF1ZXJ5LiBNYXliZSBpdCBpcyBoaXR0aW5nIGEgTW9uZ28gXCIgK1xuICAgICAgICAgICAgXCJlZGdlIGNhc2U/IFRoZSBxdWVyeSBpczogXCIgK1xuICAgICAgICAgICAgRUpTT04uc3RyaW5naWZ5KHNlbGYuX2N1cnNvckRlc2NyaXB0aW9uLnNlbGVjdG9yKSk7XG4gICAgICB9XG4gICAgICBzZWxmLl9wdWJsaXNoZWQuZm9yRWFjaChmdW5jdGlvbiAoZG9jLCBpZCkge1xuICAgICAgICBpZiAoIW5ld1Jlc3VsdHMuaGFzKGlkKSlcbiAgICAgICAgICB0aHJvdyBFcnJvcihcIl9wdWJsaXNoZWQgaGFzIGEgZG9jIHRoYXQgbmV3UmVzdWx0cyBkb2Vzbid0OyBcIiArIGlkKTtcbiAgICAgIH0pO1xuXG4gICAgICAvLyBGaW5hbGx5LCByZXBsYWNlIHRoZSBidWZmZXJcbiAgICAgIG5ld0J1ZmZlci5mb3JFYWNoKGZ1bmN0aW9uIChkb2MsIGlkKSB7XG4gICAgICAgIHNlbGYuX2FkZEJ1ZmZlcmVkKGlkLCBkb2MpO1xuICAgICAgfSk7XG5cbiAgICAgIHNlbGYuX3NhZmVBcHBlbmRUb0J1ZmZlciA9IG5ld0J1ZmZlci5zaXplKCkgPCBzZWxmLl9saW1pdDtcbiAgICB9KTtcbiAgfSxcblxuICAvLyBUaGlzIHN0b3AgZnVuY3Rpb24gaXMgaW52b2tlZCBmcm9tIHRoZSBvblN0b3Agb2YgdGhlIE9ic2VydmVNdWx0aXBsZXhlciwgc29cbiAgLy8gaXQgc2hvdWxkbid0IGFjdHVhbGx5IGJlIHBvc3NpYmxlIHRvIGNhbGwgaXQgdW50aWwgdGhlIG11bHRpcGxleGVyIGlzXG4gIC8vIHJlYWR5LlxuICAvL1xuICAvLyBJdCdzIGltcG9ydGFudCB0byBjaGVjayBzZWxmLl9zdG9wcGVkIGFmdGVyIGV2ZXJ5IGNhbGwgaW4gdGhpcyBmaWxlIHRoYXRcbiAgLy8gY2FuIHlpZWxkIVxuICBzdG9wOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmIChzZWxmLl9zdG9wcGVkKVxuICAgICAgcmV0dXJuO1xuICAgIHNlbGYuX3N0b3BwZWQgPSB0cnVlO1xuICAgIF8uZWFjaChzZWxmLl9zdG9wSGFuZGxlcywgZnVuY3Rpb24gKGhhbmRsZSkge1xuICAgICAgaGFuZGxlLnN0b3AoKTtcbiAgICB9KTtcblxuICAgIC8vIE5vdGU6IHdlICpkb24ndCogdXNlIG11bHRpcGxleGVyLm9uRmx1c2ggaGVyZSBiZWNhdXNlIHRoaXMgc3RvcFxuICAgIC8vIGNhbGxiYWNrIGlzIGFjdHVhbGx5IGludm9rZWQgYnkgdGhlIG11bHRpcGxleGVyIGl0c2VsZiB3aGVuIGl0IGhhc1xuICAgIC8vIGRldGVybWluZWQgdGhhdCB0aGVyZSBhcmUgbm8gaGFuZGxlcyBsZWZ0LiBTbyBub3RoaW5nIGlzIGFjdHVhbGx5IGdvaW5nXG4gICAgLy8gdG8gZ2V0IGZsdXNoZWQgKGFuZCBpdCdzIHByb2JhYmx5IG5vdCB2YWxpZCB0byBjYWxsIG1ldGhvZHMgb24gdGhlXG4gICAgLy8gZHlpbmcgbXVsdGlwbGV4ZXIpLlxuICAgIF8uZWFjaChzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5LCBmdW5jdGlvbiAodykge1xuICAgICAgdy5jb21taXR0ZWQoKTsgIC8vIG1heWJlIHlpZWxkcz9cbiAgICB9KTtcbiAgICBzZWxmLl93cml0ZXNUb0NvbW1pdFdoZW5XZVJlYWNoU3RlYWR5ID0gbnVsbDtcblxuICAgIC8vIFByb2FjdGl2ZWx5IGRyb3AgcmVmZXJlbmNlcyB0byBwb3RlbnRpYWxseSBiaWcgdGhpbmdzLlxuICAgIHNlbGYuX3B1Ymxpc2hlZCA9IG51bGw7XG4gICAgc2VsZi5fdW5wdWJsaXNoZWRCdWZmZXIgPSBudWxsO1xuICAgIHNlbGYuX25lZWRUb0ZldGNoID0gbnVsbDtcbiAgICBzZWxmLl9jdXJyZW50bHlGZXRjaGluZyA9IG51bGw7XG4gICAgc2VsZi5fb3Bsb2dFbnRyeUhhbmRsZSA9IG51bGw7XG4gICAgc2VsZi5fbGlzdGVuZXJzSGFuZGxlID0gbnVsbDtcblxuICAgIFBhY2thZ2UuZmFjdHMgJiYgUGFja2FnZS5mYWN0cy5GYWN0cy5pbmNyZW1lbnRTZXJ2ZXJGYWN0KFxuICAgICAgXCJtb25nby1saXZlZGF0YVwiLCBcIm9ic2VydmUtZHJpdmVycy1vcGxvZ1wiLCAtMSk7XG4gIH0sXG5cbiAgX3JlZ2lzdGVyUGhhc2VDaGFuZ2U6IGZ1bmN0aW9uIChwaGFzZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBNZXRlb3IuX25vWWllbGRzQWxsb3dlZChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgbm93ID0gbmV3IERhdGU7XG5cbiAgICAgIGlmIChzZWxmLl9waGFzZSkge1xuICAgICAgICB2YXIgdGltZURpZmYgPSBub3cgLSBzZWxmLl9waGFzZVN0YXJ0VGltZTtcbiAgICAgICAgUGFja2FnZS5mYWN0cyAmJiBQYWNrYWdlLmZhY3RzLkZhY3RzLmluY3JlbWVudFNlcnZlckZhY3QoXG4gICAgICAgICAgXCJtb25nby1saXZlZGF0YVwiLCBcInRpbWUtc3BlbnQtaW4tXCIgKyBzZWxmLl9waGFzZSArIFwiLXBoYXNlXCIsIHRpbWVEaWZmKTtcbiAgICAgIH1cblxuICAgICAgc2VsZi5fcGhhc2UgPSBwaGFzZTtcbiAgICAgIHNlbGYuX3BoYXNlU3RhcnRUaW1lID0gbm93O1xuICAgIH0pO1xuICB9XG59KTtcblxuLy8gRG9lcyBvdXIgb3Bsb2cgdGFpbGluZyBjb2RlIHN1cHBvcnQgdGhpcyBjdXJzb3I/IEZvciBub3csIHdlIGFyZSBiZWluZyB2ZXJ5XG4vLyBjb25zZXJ2YXRpdmUgYW5kIGFsbG93aW5nIG9ubHkgc2ltcGxlIHF1ZXJpZXMgd2l0aCBzaW1wbGUgb3B0aW9ucy5cbi8vIChUaGlzIGlzIGEgXCJzdGF0aWMgbWV0aG9kXCIuKVxuT3Bsb2dPYnNlcnZlRHJpdmVyLmN1cnNvclN1cHBvcnRlZCA9IGZ1bmN0aW9uIChjdXJzb3JEZXNjcmlwdGlvbiwgbWF0Y2hlcikge1xuICAvLyBGaXJzdCwgY2hlY2sgdGhlIG9wdGlvbnMuXG4gIHZhciBvcHRpb25zID0gY3Vyc29yRGVzY3JpcHRpb24ub3B0aW9ucztcblxuICAvLyBEaWQgdGhlIHVzZXIgc2F5IG5vIGV4cGxpY2l0bHk/XG4gIC8vIHVuZGVyc2NvcmVkIHZlcnNpb24gb2YgdGhlIG9wdGlvbiBpcyBDT01QQVQgd2l0aCAxLjJcbiAgaWYgKG9wdGlvbnMuZGlzYWJsZU9wbG9nIHx8IG9wdGlvbnMuX2Rpc2FibGVPcGxvZylcbiAgICByZXR1cm4gZmFsc2U7XG5cbiAgLy8gc2tpcCBpcyBub3Qgc3VwcG9ydGVkOiB0byBzdXBwb3J0IGl0IHdlIHdvdWxkIG5lZWQgdG8ga2VlcCB0cmFjayBvZiBhbGxcbiAgLy8gXCJza2lwcGVkXCIgZG9jdW1lbnRzIG9yIGF0IGxlYXN0IHRoZWlyIGlkcy5cbiAgLy8gbGltaXQgdy9vIGEgc29ydCBzcGVjaWZpZXIgaXMgbm90IHN1cHBvcnRlZDogY3VycmVudCBpbXBsZW1lbnRhdGlvbiBuZWVkcyBhXG4gIC8vIGRldGVybWluaXN0aWMgd2F5IHRvIG9yZGVyIGRvY3VtZW50cy5cbiAgaWYgKG9wdGlvbnMuc2tpcCB8fCAob3B0aW9ucy5saW1pdCAmJiAhb3B0aW9ucy5zb3J0KSkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIElmIGEgZmllbGRzIHByb2plY3Rpb24gb3B0aW9uIGlzIGdpdmVuIGNoZWNrIGlmIGl0IGlzIHN1cHBvcnRlZCBieVxuICAvLyBtaW5pbW9uZ28gKHNvbWUgb3BlcmF0b3JzIGFyZSBub3Qgc3VwcG9ydGVkKS5cbiAgaWYgKG9wdGlvbnMuZmllbGRzKSB7XG4gICAgdHJ5IHtcbiAgICAgIExvY2FsQ29sbGVjdGlvbi5fY2hlY2tTdXBwb3J0ZWRQcm9qZWN0aW9uKG9wdGlvbnMuZmllbGRzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZS5uYW1lID09PSBcIk1pbmltb25nb0Vycm9yXCIpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBXZSBkb24ndCBhbGxvdyB0aGUgZm9sbG93aW5nIHNlbGVjdG9yczpcbiAgLy8gICAtICR3aGVyZSAobm90IGNvbmZpZGVudCB0aGF0IHdlIHByb3ZpZGUgdGhlIHNhbWUgSlMgZW52aXJvbm1lbnRcbiAgLy8gICAgICAgICAgICAgYXMgTW9uZ28sIGFuZCBjYW4geWllbGQhKVxuICAvLyAgIC0gJG5lYXIgKGhhcyBcImludGVyZXN0aW5nXCIgcHJvcGVydGllcyBpbiBNb25nb0RCLCBsaWtlIHRoZSBwb3NzaWJpbGl0eVxuICAvLyAgICAgICAgICAgIG9mIHJldHVybmluZyBhbiBJRCBtdWx0aXBsZSB0aW1lcywgdGhvdWdoIGV2ZW4gcG9sbGluZyBtYXliZVxuICAvLyAgICAgICAgICAgIGhhdmUgYSBidWcgdGhlcmUpXG4gIC8vICAgICAgICAgICBYWFg6IG9uY2Ugd2Ugc3VwcG9ydCBpdCwgd2Ugd291bGQgbmVlZCB0byB0aGluayBtb3JlIG9uIGhvdyB3ZVxuICAvLyAgICAgICAgICAgaW5pdGlhbGl6ZSB0aGUgY29tcGFyYXRvcnMgd2hlbiB3ZSBjcmVhdGUgdGhlIGRyaXZlci5cbiAgcmV0dXJuICFtYXRjaGVyLmhhc1doZXJlKCkgJiYgIW1hdGNoZXIuaGFzR2VvUXVlcnkoKTtcbn07XG5cbnZhciBtb2RpZmllckNhbkJlRGlyZWN0bHlBcHBsaWVkID0gZnVuY3Rpb24gKG1vZGlmaWVyKSB7XG4gIHJldHVybiBfLmFsbChtb2RpZmllciwgZnVuY3Rpb24gKGZpZWxkcywgb3BlcmF0aW9uKSB7XG4gICAgcmV0dXJuIF8uYWxsKGZpZWxkcywgZnVuY3Rpb24gKHZhbHVlLCBmaWVsZCkge1xuICAgICAgcmV0dXJuICEvRUpTT05cXCQvLnRlc3QoZmllbGQpO1xuICAgIH0pO1xuICB9KTtcbn07XG5cbk1vbmdvSW50ZXJuYWxzLk9wbG9nT2JzZXJ2ZURyaXZlciA9IE9wbG9nT2JzZXJ2ZURyaXZlcjtcbiIsIi8vIHNpbmdsZXRvblxuZXhwb3J0IGNvbnN0IExvY2FsQ29sbGVjdGlvbkRyaXZlciA9IG5ldyAoY2xhc3MgTG9jYWxDb2xsZWN0aW9uRHJpdmVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5ub0Nvbm5Db2xsZWN0aW9ucyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gIH1cblxuICBvcGVuKG5hbWUsIGNvbm4pIHtcbiAgICBpZiAoISBuYW1lKSB7XG4gICAgICByZXR1cm4gbmV3IExvY2FsQ29sbGVjdGlvbjtcbiAgICB9XG5cbiAgICBpZiAoISBjb25uKSB7XG4gICAgICByZXR1cm4gZW5zdXJlQ29sbGVjdGlvbihuYW1lLCB0aGlzLm5vQ29ubkNvbGxlY3Rpb25zKTtcbiAgICB9XG5cbiAgICBpZiAoISBjb25uLl9tb25nb19saXZlZGF0YV9jb2xsZWN0aW9ucykge1xuICAgICAgY29ubi5fbW9uZ29fbGl2ZWRhdGFfY29sbGVjdGlvbnMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICAgIH1cblxuICAgIC8vIFhYWCBpcyB0aGVyZSBhIHdheSB0byBrZWVwIHRyYWNrIG9mIGEgY29ubmVjdGlvbidzIGNvbGxlY3Rpb25zIHdpdGhvdXRcbiAgICAvLyBkYW5nbGluZyBpdCBvZmYgdGhlIGNvbm5lY3Rpb24gb2JqZWN0P1xuICAgIHJldHVybiBlbnN1cmVDb2xsZWN0aW9uKG5hbWUsIGNvbm4uX21vbmdvX2xpdmVkYXRhX2NvbGxlY3Rpb25zKTtcbiAgfVxufSk7XG5cbmZ1bmN0aW9uIGVuc3VyZUNvbGxlY3Rpb24obmFtZSwgY29sbGVjdGlvbnMpIHtcbiAgcmV0dXJuIChuYW1lIGluIGNvbGxlY3Rpb25zKVxuICAgID8gY29sbGVjdGlvbnNbbmFtZV1cbiAgICA6IGNvbGxlY3Rpb25zW25hbWVdID0gbmV3IExvY2FsQ29sbGVjdGlvbihuYW1lKTtcbn1cbiIsIk1vbmdvSW50ZXJuYWxzLlJlbW90ZUNvbGxlY3Rpb25Ecml2ZXIgPSBmdW5jdGlvbiAoXG4gIG1vbmdvX3VybCwgb3B0aW9ucykge1xuICB2YXIgc2VsZiA9IHRoaXM7XG4gIHNlbGYubW9uZ28gPSBuZXcgTW9uZ29Db25uZWN0aW9uKG1vbmdvX3VybCwgb3B0aW9ucyk7XG59O1xuXG5fLmV4dGVuZChNb25nb0ludGVybmFscy5SZW1vdGVDb2xsZWN0aW9uRHJpdmVyLnByb3RvdHlwZSwge1xuICBvcGVuOiBmdW5jdGlvbiAobmFtZSkge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB2YXIgcmV0ID0ge307XG4gICAgXy5lYWNoKFxuICAgICAgWydmaW5kJywgJ2ZpbmRPbmUnLCAnaW5zZXJ0JywgJ3VwZGF0ZScsICd1cHNlcnQnLFxuICAgICAgICdyZW1vdmUnLCAnX2Vuc3VyZUluZGV4JywgJ19kcm9wSW5kZXgnLCAnX2NyZWF0ZUNhcHBlZENvbGxlY3Rpb24nLFxuICAgICAgICdkcm9wQ29sbGVjdGlvbicsICdyYXdDb2xsZWN0aW9uJ10sXG4gICAgICBmdW5jdGlvbiAobSkge1xuICAgICAgICByZXRbbV0gPSBfLmJpbmQoc2VsZi5tb25nb1ttXSwgc2VsZi5tb25nbywgbmFtZSk7XG4gICAgICB9KTtcbiAgICByZXR1cm4gcmV0O1xuICB9XG59KTtcblxuXG4vLyBDcmVhdGUgdGhlIHNpbmdsZXRvbiBSZW1vdGVDb2xsZWN0aW9uRHJpdmVyIG9ubHkgb24gZGVtYW5kLCBzbyB3ZVxuLy8gb25seSByZXF1aXJlIE1vbmdvIGNvbmZpZ3VyYXRpb24gaWYgaXQncyBhY3R1YWxseSB1c2VkIChlZywgbm90IGlmXG4vLyB5b3UncmUgb25seSB0cnlpbmcgdG8gcmVjZWl2ZSBkYXRhIGZyb20gYSByZW1vdGUgRERQIHNlcnZlci4pXG5Nb25nb0ludGVybmFscy5kZWZhdWx0UmVtb3RlQ29sbGVjdGlvbkRyaXZlciA9IF8ub25jZShmdW5jdGlvbiAoKSB7XG4gIHZhciBjb25uZWN0aW9uT3B0aW9ucyA9IHt9O1xuXG4gIHZhciBtb25nb1VybCA9IHByb2Nlc3MuZW52Lk1PTkdPX1VSTDtcblxuICBpZiAocHJvY2Vzcy5lbnYuTU9OR09fT1BMT0dfVVJMKSB7XG4gICAgY29ubmVjdGlvbk9wdGlvbnMub3Bsb2dVcmwgPSBwcm9jZXNzLmVudi5NT05HT19PUExPR19VUkw7XG4gIH1cblxuICBpZiAoISBtb25nb1VybClcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJNT05HT19VUkwgbXVzdCBiZSBzZXQgaW4gZW52aXJvbm1lbnRcIik7XG5cbiAgcmV0dXJuIG5ldyBNb25nb0ludGVybmFscy5SZW1vdGVDb2xsZWN0aW9uRHJpdmVyKG1vbmdvVXJsLCBjb25uZWN0aW9uT3B0aW9ucyk7XG59KTtcbiIsIi8vIG9wdGlvbnMuY29ubmVjdGlvbiwgaWYgZ2l2ZW4sIGlzIGEgTGl2ZWRhdGFDbGllbnQgb3IgTGl2ZWRhdGFTZXJ2ZXJcbi8vIFhYWCBwcmVzZW50bHkgdGhlcmUgaXMgbm8gd2F5IHRvIGRlc3Ryb3kvY2xlYW4gdXAgYSBDb2xsZWN0aW9uXG5cbi8qKlxuICogQHN1bW1hcnkgTmFtZXNwYWNlIGZvciBNb25nb0RCLXJlbGF0ZWQgaXRlbXNcbiAqIEBuYW1lc3BhY2VcbiAqL1xuTW9uZ28gPSB7fTtcblxuLyoqXG4gKiBAc3VtbWFyeSBDb25zdHJ1Y3RvciBmb3IgYSBDb2xsZWN0aW9uXG4gKiBAbG9jdXMgQW55d2hlcmVcbiAqIEBpbnN0YW5jZW5hbWUgY29sbGVjdGlvblxuICogQGNsYXNzXG4gKiBAcGFyYW0ge1N0cmluZ30gbmFtZSBUaGUgbmFtZSBvZiB0aGUgY29sbGVjdGlvbi4gIElmIG51bGwsIGNyZWF0ZXMgYW4gdW5tYW5hZ2VkICh1bnN5bmNocm9uaXplZCkgbG9jYWwgY29sbGVjdGlvbi5cbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc11cbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zLmNvbm5lY3Rpb24gVGhlIHNlcnZlciBjb25uZWN0aW9uIHRoYXQgd2lsbCBtYW5hZ2UgdGhpcyBjb2xsZWN0aW9uLiBVc2VzIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gaWYgbm90IHNwZWNpZmllZC4gIFBhc3MgdGhlIHJldHVybiB2YWx1ZSBvZiBjYWxsaW5nIFtgRERQLmNvbm5lY3RgXSgjZGRwX2Nvbm5lY3QpIHRvIHNwZWNpZnkgYSBkaWZmZXJlbnQgc2VydmVyLiBQYXNzIGBudWxsYCB0byBzcGVjaWZ5IG5vIGNvbm5lY3Rpb24uIFVubWFuYWdlZCAoYG5hbWVgIGlzIG51bGwpIGNvbGxlY3Rpb25zIGNhbm5vdCBzcGVjaWZ5IGEgY29ubmVjdGlvbi5cbiAqIEBwYXJhbSB7U3RyaW5nfSBvcHRpb25zLmlkR2VuZXJhdGlvbiBUaGUgbWV0aG9kIG9mIGdlbmVyYXRpbmcgdGhlIGBfaWRgIGZpZWxkcyBvZiBuZXcgZG9jdW1lbnRzIGluIHRoaXMgY29sbGVjdGlvbi4gIFBvc3NpYmxlIHZhbHVlczpcblxuIC0gKipgJ1NUUklORydgKio6IHJhbmRvbSBzdHJpbmdzXG4gLSAqKmAnTU9OR08nYCoqOiAgcmFuZG9tIFtgTW9uZ28uT2JqZWN0SURgXSgjbW9uZ29fb2JqZWN0X2lkKSB2YWx1ZXNcblxuVGhlIGRlZmF1bHQgaWQgZ2VuZXJhdGlvbiB0ZWNobmlxdWUgaXMgYCdTVFJJTkcnYC5cbiAqIEBwYXJhbSB7RnVuY3Rpb259IG9wdGlvbnMudHJhbnNmb3JtIEFuIG9wdGlvbmFsIHRyYW5zZm9ybWF0aW9uIGZ1bmN0aW9uLiBEb2N1bWVudHMgd2lsbCBiZSBwYXNzZWQgdGhyb3VnaCB0aGlzIGZ1bmN0aW9uIGJlZm9yZSBiZWluZyByZXR1cm5lZCBmcm9tIGBmZXRjaGAgb3IgYGZpbmRPbmVgLCBhbmQgYmVmb3JlIGJlaW5nIHBhc3NlZCB0byBjYWxsYmFja3Mgb2YgYG9ic2VydmVgLCBgbWFwYCwgYGZvckVhY2hgLCBgYWxsb3dgLCBhbmQgYGRlbnlgLiBUcmFuc2Zvcm1zIGFyZSAqbm90KiBhcHBsaWVkIGZvciB0aGUgY2FsbGJhY2tzIG9mIGBvYnNlcnZlQ2hhbmdlc2Agb3IgdG8gY3Vyc29ycyByZXR1cm5lZCBmcm9tIHB1Ymxpc2ggZnVuY3Rpb25zLlxuICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLmRlZmluZU11dGF0aW9uTWV0aG9kcyBTZXQgdG8gYGZhbHNlYCB0byBza2lwIHNldHRpbmcgdXAgdGhlIG11dGF0aW9uIG1ldGhvZHMgdGhhdCBlbmFibGUgaW5zZXJ0L3VwZGF0ZS9yZW1vdmUgZnJvbSBjbGllbnQgY29kZS4gRGVmYXVsdCBgdHJ1ZWAuXG4gKi9cbk1vbmdvLkNvbGxlY3Rpb24gPSBmdW5jdGlvbiBDb2xsZWN0aW9uKG5hbWUsIG9wdGlvbnMpIHtcbiAgaWYgKCFuYW1lICYmIChuYW1lICE9PSBudWxsKSkge1xuICAgIE1ldGVvci5fZGVidWcoXCJXYXJuaW5nOiBjcmVhdGluZyBhbm9ueW1vdXMgY29sbGVjdGlvbi4gSXQgd2lsbCBub3QgYmUgXCIgK1xuICAgICAgICAgICAgICAgICAgXCJzYXZlZCBvciBzeW5jaHJvbml6ZWQgb3ZlciB0aGUgbmV0d29yay4gKFBhc3MgbnVsbCBmb3IgXCIgK1xuICAgICAgICAgICAgICAgICAgXCJ0aGUgY29sbGVjdGlvbiBuYW1lIHRvIHR1cm4gb2ZmIHRoaXMgd2FybmluZy4pXCIpO1xuICAgIG5hbWUgPSBudWxsO1xuICB9XG5cbiAgaWYgKG5hbWUgIT09IG51bGwgJiYgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkZpcnN0IGFyZ3VtZW50IHRvIG5ldyBNb25nby5Db2xsZWN0aW9uIG11c3QgYmUgYSBzdHJpbmcgb3IgbnVsbFwiKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zICYmIG9wdGlvbnMubWV0aG9kcykge1xuICAgIC8vIEJhY2t3YXJkcyBjb21wYXRpYmlsaXR5IGhhY2sgd2l0aCBvcmlnaW5hbCBzaWduYXR1cmUgKHdoaWNoIHBhc3NlZFxuICAgIC8vIFwiY29ubmVjdGlvblwiIGRpcmVjdGx5IGluc3RlYWQgb2YgaW4gb3B0aW9ucy4gKENvbm5lY3Rpb25zIG11c3QgaGF2ZSBhIFwibWV0aG9kc1wiXG4gICAgLy8gbWV0aG9kLilcbiAgICAvLyBYWFggcmVtb3ZlIGJlZm9yZSAxLjBcbiAgICBvcHRpb25zID0ge2Nvbm5lY3Rpb246IG9wdGlvbnN9O1xuICB9XG4gIC8vIEJhY2t3YXJkcyBjb21wYXRpYmlsaXR5OiBcImNvbm5lY3Rpb25cIiB1c2VkIHRvIGJlIGNhbGxlZCBcIm1hbmFnZXJcIi5cbiAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5tYW5hZ2VyICYmICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICBvcHRpb25zLmNvbm5lY3Rpb24gPSBvcHRpb25zLm1hbmFnZXI7XG4gIH1cblxuICBvcHRpb25zID0ge1xuICAgIGNvbm5lY3Rpb246IHVuZGVmaW5lZCxcbiAgICBpZEdlbmVyYXRpb246ICdTVFJJTkcnLFxuICAgIHRyYW5zZm9ybTogbnVsbCxcbiAgICBfZHJpdmVyOiB1bmRlZmluZWQsXG4gICAgX3ByZXZlbnRBdXRvcHVibGlzaDogZmFsc2UsXG4gICAgICAuLi5vcHRpb25zLFxuICB9O1xuXG4gIHN3aXRjaCAob3B0aW9ucy5pZEdlbmVyYXRpb24pIHtcbiAgY2FzZSAnTU9OR08nOlxuICAgIHRoaXMuX21ha2VOZXdJRCA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBzcmMgPSBuYW1lID8gRERQLnJhbmRvbVN0cmVhbSgnL2NvbGxlY3Rpb24vJyArIG5hbWUpIDogUmFuZG9tLmluc2VjdXJlO1xuICAgICAgcmV0dXJuIG5ldyBNb25nby5PYmplY3RJRChzcmMuaGV4U3RyaW5nKDI0KSk7XG4gICAgfTtcbiAgICBicmVhaztcbiAgY2FzZSAnU1RSSU5HJzpcbiAgZGVmYXVsdDpcbiAgICB0aGlzLl9tYWtlTmV3SUQgPSBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgc3JjID0gbmFtZSA/IEREUC5yYW5kb21TdHJlYW0oJy9jb2xsZWN0aW9uLycgKyBuYW1lKSA6IFJhbmRvbS5pbnNlY3VyZTtcbiAgICAgIHJldHVybiBzcmMuaWQoKTtcbiAgICB9O1xuICAgIGJyZWFrO1xuICB9XG5cbiAgdGhpcy5fdHJhbnNmb3JtID0gTG9jYWxDb2xsZWN0aW9uLndyYXBUcmFuc2Zvcm0ob3B0aW9ucy50cmFuc2Zvcm0pO1xuXG4gIGlmICghIG5hbWUgfHwgb3B0aW9ucy5jb25uZWN0aW9uID09PSBudWxsKVxuICAgIC8vIG5vdGU6IG5hbWVsZXNzIGNvbGxlY3Rpb25zIG5ldmVyIGhhdmUgYSBjb25uZWN0aW9uXG4gICAgdGhpcy5fY29ubmVjdGlvbiA9IG51bGw7XG4gIGVsc2UgaWYgKG9wdGlvbnMuY29ubmVjdGlvbilcbiAgICB0aGlzLl9jb25uZWN0aW9uID0gb3B0aW9ucy5jb25uZWN0aW9uO1xuICBlbHNlIGlmIChNZXRlb3IuaXNDbGllbnQpXG4gICAgdGhpcy5fY29ubmVjdGlvbiA9IE1ldGVvci5jb25uZWN0aW9uO1xuICBlbHNlXG4gICAgdGhpcy5fY29ubmVjdGlvbiA9IE1ldGVvci5zZXJ2ZXI7XG5cbiAgaWYgKCFvcHRpb25zLl9kcml2ZXIpIHtcbiAgICAvLyBYWFggVGhpcyBjaGVjayBhc3N1bWVzIHRoYXQgd2ViYXBwIGlzIGxvYWRlZCBzbyB0aGF0IE1ldGVvci5zZXJ2ZXIgIT09XG4gICAgLy8gbnVsbC4gV2Ugc2hvdWxkIGZ1bGx5IHN1cHBvcnQgdGhlIGNhc2Ugb2YgXCJ3YW50IHRvIHVzZSBhIE1vbmdvLWJhY2tlZFxuICAgIC8vIGNvbGxlY3Rpb24gZnJvbSBOb2RlIGNvZGUgd2l0aG91dCB3ZWJhcHBcIiwgYnV0IHdlIGRvbid0IHlldC5cbiAgICAvLyAjTWV0ZW9yU2VydmVyTnVsbFxuICAgIGlmIChuYW1lICYmIHRoaXMuX2Nvbm5lY3Rpb24gPT09IE1ldGVvci5zZXJ2ZXIgJiZcbiAgICAgICAgdHlwZW9mIE1vbmdvSW50ZXJuYWxzICE9PSBcInVuZGVmaW5lZFwiICYmXG4gICAgICAgIE1vbmdvSW50ZXJuYWxzLmRlZmF1bHRSZW1vdGVDb2xsZWN0aW9uRHJpdmVyKSB7XG4gICAgICBvcHRpb25zLl9kcml2ZXIgPSBNb25nb0ludGVybmFscy5kZWZhdWx0UmVtb3RlQ29sbGVjdGlvbkRyaXZlcigpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCB7IExvY2FsQ29sbGVjdGlvbkRyaXZlciB9ID1cbiAgICAgICAgcmVxdWlyZShcIi4vbG9jYWxfY29sbGVjdGlvbl9kcml2ZXIuanNcIik7XG4gICAgICBvcHRpb25zLl9kcml2ZXIgPSBMb2NhbENvbGxlY3Rpb25Ecml2ZXI7XG4gICAgfVxuICB9XG5cbiAgdGhpcy5fY29sbGVjdGlvbiA9IG9wdGlvbnMuX2RyaXZlci5vcGVuKG5hbWUsIHRoaXMuX2Nvbm5lY3Rpb24pO1xuICB0aGlzLl9uYW1lID0gbmFtZTtcbiAgdGhpcy5fZHJpdmVyID0gb3B0aW9ucy5fZHJpdmVyO1xuXG4gIHRoaXMuX21heWJlU2V0VXBSZXBsaWNhdGlvbihuYW1lLCBvcHRpb25zKTtcblxuICAvLyBYWFggZG9uJ3QgZGVmaW5lIHRoZXNlIHVudGlsIGFsbG93IG9yIGRlbnkgaXMgYWN0dWFsbHkgdXNlZCBmb3IgdGhpc1xuICAvLyBjb2xsZWN0aW9uLiBDb3VsZCBiZSBoYXJkIGlmIHRoZSBzZWN1cml0eSBydWxlcyBhcmUgb25seSBkZWZpbmVkIG9uIHRoZVxuICAvLyBzZXJ2ZXIuXG4gIGlmIChvcHRpb25zLmRlZmluZU11dGF0aW9uTWV0aG9kcyAhPT0gZmFsc2UpIHtcbiAgICB0cnkge1xuICAgICAgdGhpcy5fZGVmaW5lTXV0YXRpb25NZXRob2RzKHtcbiAgICAgICAgdXNlRXhpc3Rpbmc6IG9wdGlvbnMuX3N1cHByZXNzU2FtZU5hbWVFcnJvciA9PT0gdHJ1ZVxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIC8vIFRocm93IGEgbW9yZSB1bmRlcnN0YW5kYWJsZSBlcnJvciBvbiB0aGUgc2VydmVyIGZvciBzYW1lIGNvbGxlY3Rpb24gbmFtZVxuICAgICAgaWYgKGVycm9yLm1lc3NhZ2UgPT09IGBBIG1ldGhvZCBuYW1lZCAnLyR7bmFtZX0vaW5zZXJ0JyBpcyBhbHJlYWR5IGRlZmluZWRgKVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZXJlIGlzIGFscmVhZHkgYSBjb2xsZWN0aW9uIG5hbWVkIFwiJHtuYW1lfVwiYCk7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gIH1cblxuICAvLyBhdXRvcHVibGlzaFxuICBpZiAoUGFja2FnZS5hdXRvcHVibGlzaCAmJlxuICAgICAgISBvcHRpb25zLl9wcmV2ZW50QXV0b3B1Ymxpc2ggJiZcbiAgICAgIHRoaXMuX2Nvbm5lY3Rpb24gJiZcbiAgICAgIHRoaXMuX2Nvbm5lY3Rpb24ucHVibGlzaCkge1xuICAgIHRoaXMuX2Nvbm5lY3Rpb24ucHVibGlzaChudWxsLCAoKSA9PiB0aGlzLmZpbmQoKSwge1xuICAgICAgaXNfYXV0bzogdHJ1ZSxcbiAgICB9KTtcbiAgfVxufTtcblxuT2JqZWN0LmFzc2lnbihNb25nby5Db2xsZWN0aW9uLnByb3RvdHlwZSwge1xuICBfbWF5YmVTZXRVcFJlcGxpY2F0aW9uKG5hbWUsIHtcbiAgICBfc3VwcHJlc3NTYW1lTmFtZUVycm9yID0gZmFsc2VcbiAgfSkge1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIGlmICghIChzZWxmLl9jb25uZWN0aW9uICYmXG4gICAgICAgICAgIHNlbGYuX2Nvbm5lY3Rpb24ucmVnaXN0ZXJTdG9yZSkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBPSywgd2UncmUgZ29pbmcgdG8gYmUgYSBzbGF2ZSwgcmVwbGljYXRpbmcgc29tZSByZW1vdGVcbiAgICAvLyBkYXRhYmFzZSwgZXhjZXB0IHBvc3NpYmx5IHdpdGggc29tZSB0ZW1wb3JhcnkgZGl2ZXJnZW5jZSB3aGlsZVxuICAgIC8vIHdlIGhhdmUgdW5hY2tub3dsZWRnZWQgUlBDJ3MuXG4gICAgY29uc3Qgb2sgPSBzZWxmLl9jb25uZWN0aW9uLnJlZ2lzdGVyU3RvcmUobmFtZSwge1xuICAgICAgLy8gQ2FsbGVkIGF0IHRoZSBiZWdpbm5pbmcgb2YgYSBiYXRjaCBvZiB1cGRhdGVzLiBiYXRjaFNpemUgaXMgdGhlIG51bWJlclxuICAgICAgLy8gb2YgdXBkYXRlIGNhbGxzIHRvIGV4cGVjdC5cbiAgICAgIC8vXG4gICAgICAvLyBYWFggVGhpcyBpbnRlcmZhY2UgaXMgcHJldHR5IGphbmt5LiByZXNldCBwcm9iYWJseSBvdWdodCB0byBnbyBiYWNrIHRvXG4gICAgICAvLyBiZWluZyBpdHMgb3duIGZ1bmN0aW9uLCBhbmQgY2FsbGVycyBzaG91bGRuJ3QgaGF2ZSB0byBjYWxjdWxhdGVcbiAgICAgIC8vIGJhdGNoU2l6ZS4gVGhlIG9wdGltaXphdGlvbiBvZiBub3QgY2FsbGluZyBwYXVzZS9yZW1vdmUgc2hvdWxkIGJlXG4gICAgICAvLyBkZWxheWVkIHVudGlsIGxhdGVyOiB0aGUgZmlyc3QgY2FsbCB0byB1cGRhdGUoKSBzaG91bGQgYnVmZmVyIGl0c1xuICAgICAgLy8gbWVzc2FnZSwgYW5kIHRoZW4gd2UgY2FuIGVpdGhlciBkaXJlY3RseSBhcHBseSBpdCBhdCBlbmRVcGRhdGUgdGltZSBpZlxuICAgICAgLy8gaXQgd2FzIHRoZSBvbmx5IHVwZGF0ZSwgb3IgZG8gcGF1c2VPYnNlcnZlcnMvYXBwbHkvYXBwbHkgYXQgdGhlIG5leHRcbiAgICAgIC8vIHVwZGF0ZSgpIGlmIHRoZXJlJ3MgYW5vdGhlciBvbmUuXG4gICAgICBiZWdpblVwZGF0ZShiYXRjaFNpemUsIHJlc2V0KSB7XG4gICAgICAgIC8vIHBhdXNlIG9ic2VydmVycyBzbyB1c2VycyBkb24ndCBzZWUgZmxpY2tlciB3aGVuIHVwZGF0aW5nIHNldmVyYWxcbiAgICAgICAgLy8gb2JqZWN0cyBhdCBvbmNlIChpbmNsdWRpbmcgdGhlIHBvc3QtcmVjb25uZWN0IHJlc2V0LWFuZC1yZWFwcGx5XG4gICAgICAgIC8vIHN0YWdlKSwgYW5kIHNvIHRoYXQgYSByZS1zb3J0aW5nIG9mIGEgcXVlcnkgY2FuIHRha2UgYWR2YW50YWdlIG9mIHRoZVxuICAgICAgICAvLyBmdWxsIF9kaWZmUXVlcnkgbW92ZWQgY2FsY3VsYXRpb24gaW5zdGVhZCBvZiBhcHBseWluZyBjaGFuZ2Ugb25lIGF0IGFcbiAgICAgICAgLy8gdGltZS5cbiAgICAgICAgaWYgKGJhdGNoU2l6ZSA+IDEgfHwgcmVzZXQpXG4gICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5wYXVzZU9ic2VydmVycygpO1xuXG4gICAgICAgIGlmIChyZXNldClcbiAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnJlbW92ZSh7fSk7XG4gICAgICB9LFxuXG4gICAgICAvLyBBcHBseSBhbiB1cGRhdGUuXG4gICAgICAvLyBYWFggYmV0dGVyIHNwZWNpZnkgdGhpcyBpbnRlcmZhY2UgKG5vdCBpbiB0ZXJtcyBvZiBhIHdpcmUgbWVzc2FnZSk/XG4gICAgICB1cGRhdGUobXNnKSB7XG4gICAgICAgIHZhciBtb25nb0lkID0gTW9uZ29JRC5pZFBhcnNlKG1zZy5pZCk7XG4gICAgICAgIHZhciBkb2MgPSBzZWxmLl9jb2xsZWN0aW9uLmZpbmRPbmUobW9uZ29JZCk7XG5cbiAgICAgICAgLy8gSXMgdGhpcyBhIFwicmVwbGFjZSB0aGUgd2hvbGUgZG9jXCIgbWVzc2FnZSBjb21pbmcgZnJvbSB0aGUgcXVpZXNjZW5jZVxuICAgICAgICAvLyBvZiBtZXRob2Qgd3JpdGVzIHRvIGFuIG9iamVjdD8gKE5vdGUgdGhhdCAndW5kZWZpbmVkJyBpcyBhIHZhbGlkXG4gICAgICAgIC8vIHZhbHVlIG1lYW5pbmcgXCJyZW1vdmUgaXRcIi4pXG4gICAgICAgIGlmIChtc2cubXNnID09PSAncmVwbGFjZScpIHtcbiAgICAgICAgICB2YXIgcmVwbGFjZSA9IG1zZy5yZXBsYWNlO1xuICAgICAgICAgIGlmICghcmVwbGFjZSkge1xuICAgICAgICAgICAgaWYgKGRvYylcbiAgICAgICAgICAgICAgc2VsZi5fY29sbGVjdGlvbi5yZW1vdmUobW9uZ29JZCk7XG4gICAgICAgICAgfSBlbHNlIGlmICghZG9jKSB7XG4gICAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLmluc2VydChyZXBsYWNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gWFhYIGNoZWNrIHRoYXQgcmVwbGFjZSBoYXMgbm8gJCBvcHNcbiAgICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24udXBkYXRlKG1vbmdvSWQsIHJlcGxhY2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gZWxzZSBpZiAobXNnLm1zZyA9PT0gJ2FkZGVkJykge1xuICAgICAgICAgIGlmIChkb2MpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIG5vdCB0byBmaW5kIGEgZG9jdW1lbnQgYWxyZWFkeSBwcmVzZW50IGZvciBhbiBhZGRcIik7XG4gICAgICAgICAgfVxuICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24uaW5zZXJ0KHsgX2lkOiBtb25nb0lkLCAuLi5tc2cuZmllbGRzIH0pO1xuICAgICAgICB9IGVsc2UgaWYgKG1zZy5tc2cgPT09ICdyZW1vdmVkJykge1xuICAgICAgICAgIGlmICghZG9jKVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRXhwZWN0ZWQgdG8gZmluZCBhIGRvY3VtZW50IGFscmVhZHkgcHJlc2VudCBmb3IgcmVtb3ZlZFwiKTtcbiAgICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnJlbW92ZShtb25nb0lkKTtcbiAgICAgICAgfSBlbHNlIGlmIChtc2cubXNnID09PSAnY2hhbmdlZCcpIHtcbiAgICAgICAgICBpZiAoIWRvYylcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIHRvIGZpbmQgYSBkb2N1bWVudCB0byBjaGFuZ2VcIik7XG4gICAgICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG1zZy5maWVsZHMpO1xuICAgICAgICAgIGlmIChrZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHZhciBtb2RpZmllciA9IHt9O1xuICAgICAgICAgICAga2V5cy5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gbXNnLmZpZWxkc1trZXldO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFtb2RpZmllci4kdW5zZXQpIHtcbiAgICAgICAgICAgICAgICAgIG1vZGlmaWVyLiR1bnNldCA9IHt9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtb2RpZmllci4kdW5zZXRba2V5XSA9IDE7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKCFtb2RpZmllci4kc2V0KSB7XG4gICAgICAgICAgICAgICAgICBtb2RpZmllci4kc2V0ID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1vZGlmaWVyLiRzZXRba2V5XSA9IHZhbHVlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNlbGYuX2NvbGxlY3Rpb24udXBkYXRlKG1vbmdvSWQsIG1vZGlmaWVyKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSSBkb24ndCBrbm93IGhvdyB0byBkZWFsIHdpdGggdGhpcyBtZXNzYWdlXCIpO1xuICAgICAgICB9XG4gICAgICB9LFxuXG4gICAgICAvLyBDYWxsZWQgYXQgdGhlIGVuZCBvZiBhIGJhdGNoIG9mIHVwZGF0ZXMuXG4gICAgICBlbmRVcGRhdGUoKSB7XG4gICAgICAgIHNlbGYuX2NvbGxlY3Rpb24ucmVzdW1lT2JzZXJ2ZXJzKCk7XG4gICAgICB9LFxuXG4gICAgICAvLyBDYWxsZWQgYXJvdW5kIG1ldGhvZCBzdHViIGludm9jYXRpb25zIHRvIGNhcHR1cmUgdGhlIG9yaWdpbmFsIHZlcnNpb25zXG4gICAgICAvLyBvZiBtb2RpZmllZCBkb2N1bWVudHMuXG4gICAgICBzYXZlT3JpZ2luYWxzKCkge1xuICAgICAgICBzZWxmLl9jb2xsZWN0aW9uLnNhdmVPcmlnaW5hbHMoKTtcbiAgICAgIH0sXG4gICAgICByZXRyaWV2ZU9yaWdpbmFscygpIHtcbiAgICAgICAgcmV0dXJuIHNlbGYuX2NvbGxlY3Rpb24ucmV0cmlldmVPcmlnaW5hbHMoKTtcbiAgICAgIH0sXG5cbiAgICAgIC8vIFVzZWQgdG8gcHJlc2VydmUgY3VycmVudCB2ZXJzaW9ucyBvZiBkb2N1bWVudHMgYWNyb3NzIGEgc3RvcmUgcmVzZXQuXG4gICAgICBnZXREb2MoaWQpIHtcbiAgICAgICAgcmV0dXJuIHNlbGYuZmluZE9uZShpZCk7XG4gICAgICB9LFxuXG4gICAgICAvLyBUbyBiZSBhYmxlIHRvIGdldCBiYWNrIHRvIHRoZSBjb2xsZWN0aW9uIGZyb20gdGhlIHN0b3JlLlxuICAgICAgX2dldENvbGxlY3Rpb24oKSB7XG4gICAgICAgIHJldHVybiBzZWxmO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKCEgb2spIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgVGhlcmUgaXMgYWxyZWFkeSBhIGNvbGxlY3Rpb24gbmFtZWQgXCIke25hbWV9XCJgO1xuICAgICAgaWYgKF9zdXBwcmVzc1NhbWVOYW1lRXJyb3IgPT09IHRydWUpIHtcbiAgICAgICAgLy8gWFhYIEluIHRoZW9yeSB3ZSBkbyBub3QgaGF2ZSB0byB0aHJvdyB3aGVuIGBva2AgaXMgZmFsc3kuIFRoZVxuICAgICAgICAvLyBzdG9yZSBpcyBhbHJlYWR5IGRlZmluZWQgZm9yIHRoaXMgY29sbGVjdGlvbiBuYW1lLCBidXQgdGhpc1xuICAgICAgICAvLyB3aWxsIHNpbXBseSBiZSBhbm90aGVyIHJlZmVyZW5jZSB0byBpdCBhbmQgZXZlcnl0aGluZyBzaG91bGRcbiAgICAgICAgLy8gd29yay4gSG93ZXZlciwgd2UgaGF2ZSBoaXN0b3JpY2FsbHkgdGhyb3duIGFuIGVycm9yIGhlcmUsIHNvXG4gICAgICAgIC8vIGZvciBub3cgd2Ugd2lsbCBza2lwIHRoZSBlcnJvciBvbmx5IHdoZW4gX3N1cHByZXNzU2FtZU5hbWVFcnJvclxuICAgICAgICAvLyBpcyBgdHJ1ZWAsIGFsbG93aW5nIHBlb3BsZSB0byBvcHQgaW4gYW5kIGdpdmUgdGhpcyBzb21lIHJlYWxcbiAgICAgICAgLy8gd29ybGQgdGVzdGluZy5cbiAgICAgICAgY29uc29sZS53YXJuID8gY29uc29sZS53YXJuKG1lc3NhZ2UpIDogY29uc29sZS5sb2cobWVzc2FnZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICB9XG4gICAgfVxuICB9LFxuXG4gIC8vL1xuICAvLy8gTWFpbiBjb2xsZWN0aW9uIEFQSVxuICAvLy9cblxuICBfZ2V0RmluZFNlbGVjdG9yKGFyZ3MpIHtcbiAgICBpZiAoYXJncy5sZW5ndGggPT0gMClcbiAgICAgIHJldHVybiB7fTtcbiAgICBlbHNlXG4gICAgICByZXR1cm4gYXJnc1swXTtcbiAgfSxcblxuICBfZ2V0RmluZE9wdGlvbnMoYXJncykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoYXJncy5sZW5ndGggPCAyKSB7XG4gICAgICByZXR1cm4geyB0cmFuc2Zvcm06IHNlbGYuX3RyYW5zZm9ybSB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBjaGVjayhhcmdzWzFdLCBNYXRjaC5PcHRpb25hbChNYXRjaC5PYmplY3RJbmNsdWRpbmcoe1xuICAgICAgICBmaWVsZHM6IE1hdGNoLk9wdGlvbmFsKE1hdGNoLk9uZU9mKE9iamVjdCwgdW5kZWZpbmVkKSksXG4gICAgICAgIHNvcnQ6IE1hdGNoLk9wdGlvbmFsKE1hdGNoLk9uZU9mKE9iamVjdCwgQXJyYXksIEZ1bmN0aW9uLCB1bmRlZmluZWQpKSxcbiAgICAgICAgbGltaXQ6IE1hdGNoLk9wdGlvbmFsKE1hdGNoLk9uZU9mKE51bWJlciwgdW5kZWZpbmVkKSksXG4gICAgICAgIHNraXA6IE1hdGNoLk9wdGlvbmFsKE1hdGNoLk9uZU9mKE51bWJlciwgdW5kZWZpbmVkKSlcbiAgICAgIH0pKSk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHRyYW5zZm9ybTogc2VsZi5fdHJhbnNmb3JtLFxuICAgICAgICAuLi5hcmdzWzFdLFxuICAgICAgfTtcbiAgICB9XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IEZpbmQgdGhlIGRvY3VtZW50cyBpbiBhIGNvbGxlY3Rpb24gdGhhdCBtYXRjaCB0aGUgc2VsZWN0b3IuXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kIGZpbmRcbiAgICogQG1lbWJlck9mIE1vbmdvLkNvbGxlY3Rpb25cbiAgICogQGluc3RhbmNlXG4gICAqIEBwYXJhbSB7TW9uZ29TZWxlY3Rvcn0gW3NlbGVjdG9yXSBBIHF1ZXJ5IGRlc2NyaWJpbmcgdGhlIGRvY3VtZW50cyB0byBmaW5kXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc11cbiAgICogQHBhcmFtIHtNb25nb1NvcnRTcGVjaWZpZXJ9IG9wdGlvbnMuc29ydCBTb3J0IG9yZGVyIChkZWZhdWx0OiBuYXR1cmFsIG9yZGVyKVxuICAgKiBAcGFyYW0ge051bWJlcn0gb3B0aW9ucy5za2lwIE51bWJlciBvZiByZXN1bHRzIHRvIHNraXAgYXQgdGhlIGJlZ2lubmluZ1xuICAgKiBAcGFyYW0ge051bWJlcn0gb3B0aW9ucy5saW1pdCBNYXhpbXVtIG51bWJlciBvZiByZXN1bHRzIHRvIHJldHVyblxuICAgKiBAcGFyYW0ge01vbmdvRmllbGRTcGVjaWZpZXJ9IG9wdGlvbnMuZmllbGRzIERpY3Rpb25hcnkgb2YgZmllbGRzIHRvIHJldHVybiBvciBleGNsdWRlLlxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMucmVhY3RpdmUgKENsaWVudCBvbmx5KSBEZWZhdWx0IGB0cnVlYDsgcGFzcyBgZmFsc2VgIHRvIGRpc2FibGUgcmVhY3Rpdml0eVxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBvcHRpb25zLnRyYW5zZm9ybSBPdmVycmlkZXMgYHRyYW5zZm9ybWAgb24gdGhlICBbYENvbGxlY3Rpb25gXSgjY29sbGVjdGlvbnMpIGZvciB0aGlzIGN1cnNvci4gIFBhc3MgYG51bGxgIHRvIGRpc2FibGUgdHJhbnNmb3JtYXRpb24uXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gb3B0aW9ucy5kaXNhYmxlT3Bsb2cgKFNlcnZlciBvbmx5KSBQYXNzIHRydWUgdG8gZGlzYWJsZSBvcGxvZy10YWlsaW5nIG9uIHRoaXMgcXVlcnkuIFRoaXMgYWZmZWN0cyB0aGUgd2F5IHNlcnZlciBwcm9jZXNzZXMgY2FsbHMgdG8gYG9ic2VydmVgIG9uIHRoaXMgcXVlcnkuIERpc2FibGluZyB0aGUgb3Bsb2cgY2FuIGJlIHVzZWZ1bCB3aGVuIHdvcmtpbmcgd2l0aCBkYXRhIHRoYXQgdXBkYXRlcyBpbiBsYXJnZSBiYXRjaGVzLlxuICAgKiBAcGFyYW0ge051bWJlcn0gb3B0aW9ucy5wb2xsaW5nSW50ZXJ2YWxNcyAoU2VydmVyIG9ubHkpIFdoZW4gb3Bsb2cgaXMgZGlzYWJsZWQgKHRocm91Z2ggdGhlIHVzZSBvZiBgZGlzYWJsZU9wbG9nYCBvciB3aGVuIG90aGVyd2lzZSBub3QgYXZhaWxhYmxlKSwgdGhlIGZyZXF1ZW5jeSAoaW4gbWlsbGlzZWNvbmRzKSBvZiBob3cgb2Z0ZW4gdG8gcG9sbCB0aGlzIHF1ZXJ5IHdoZW4gb2JzZXJ2aW5nIG9uIHRoZSBzZXJ2ZXIuIERlZmF1bHRzIHRvIDEwMDAwbXMgKDEwIHNlY29uZHMpLlxuICAgKiBAcGFyYW0ge051bWJlcn0gb3B0aW9ucy5wb2xsaW5nVGhyb3R0bGVNcyAoU2VydmVyIG9ubHkpIFdoZW4gb3Bsb2cgaXMgZGlzYWJsZWQgKHRocm91Z2ggdGhlIHVzZSBvZiBgZGlzYWJsZU9wbG9nYCBvciB3aGVuIG90aGVyd2lzZSBub3QgYXZhaWxhYmxlKSwgdGhlIG1pbmltdW0gdGltZSAoaW4gbWlsbGlzZWNvbmRzKSB0byBhbGxvdyBiZXR3ZWVuIHJlLXBvbGxpbmcgd2hlbiBvYnNlcnZpbmcgb24gdGhlIHNlcnZlci4gSW5jcmVhc2luZyB0aGlzIHdpbGwgc2F2ZSBDUFUgYW5kIG1vbmdvIGxvYWQgYXQgdGhlIGV4cGVuc2Ugb2Ygc2xvd2VyIHVwZGF0ZXMgdG8gdXNlcnMuIERlY3JlYXNpbmcgdGhpcyBpcyBub3QgcmVjb21tZW5kZWQuIERlZmF1bHRzIHRvIDUwbXMuXG4gICAqIEBwYXJhbSB7TnVtYmVyfSBvcHRpb25zLm1heFRpbWVNcyAoU2VydmVyIG9ubHkpIElmIHNldCwgaW5zdHJ1Y3RzIE1vbmdvREIgdG8gc2V0IGEgdGltZSBsaW1pdCBmb3IgdGhpcyBjdXJzb3IncyBvcGVyYXRpb25zLiBJZiB0aGUgb3BlcmF0aW9uIHJlYWNoZXMgdGhlIHNwZWNpZmllZCB0aW1lIGxpbWl0IChpbiBtaWxsaXNlY29uZHMpIHdpdGhvdXQgdGhlIGhhdmluZyBiZWVuIGNvbXBsZXRlZCwgYW4gZXhjZXB0aW9uIHdpbGwgYmUgdGhyb3duLiBVc2VmdWwgdG8gcHJldmVudCBhbiAoYWNjaWRlbnRhbCBvciBtYWxpY2lvdXMpIHVub3B0aW1pemVkIHF1ZXJ5IGZyb20gY2F1c2luZyBhIGZ1bGwgY29sbGVjdGlvbiBzY2FuIHRoYXQgd291bGQgZGlzcnVwdCBvdGhlciBkYXRhYmFzZSB1c2VycywgYXQgdGhlIGV4cGVuc2Ugb2YgbmVlZGluZyB0byBoYW5kbGUgdGhlIHJlc3VsdGluZyBlcnJvci5cbiAgICogQHBhcmFtIHtTdHJpbmd8T2JqZWN0fSBvcHRpb25zLmhpbnQgKFNlcnZlciBvbmx5KSBPdmVycmlkZXMgTW9uZ29EQidzIGRlZmF1bHQgaW5kZXggc2VsZWN0aW9uIGFuZCBxdWVyeSBvcHRpbWl6YXRpb24gcHJvY2Vzcy4gU3BlY2lmeSBhbiBpbmRleCB0byBmb3JjZSBpdHMgdXNlLCBlaXRoZXIgYnkgaXRzIG5hbWUgb3IgaW5kZXggc3BlY2lmaWNhdGlvbi4gWW91IGNhbiBhbHNvIHNwZWNpZnkgYHsgJG5hdHVyYWwgOiAxIH1gIHRvIGZvcmNlIGEgZm9yd2FyZHMgY29sbGVjdGlvbiBzY2FuLCBvciBgeyAkbmF0dXJhbCA6IC0xIH1gIGZvciBhIHJldmVyc2UgY29sbGVjdGlvbiBzY2FuLiBTZXR0aW5nIHRoaXMgaXMgb25seSByZWNvbW1lbmRlZCBmb3IgYWR2YW5jZWQgdXNlcnMuXG4gICAqIEByZXR1cm5zIHtNb25nby5DdXJzb3J9XG4gICAqL1xuICBmaW5kKC4uLmFyZ3MpIHtcbiAgICAvLyBDb2xsZWN0aW9uLmZpbmQoKSAocmV0dXJuIGFsbCBkb2NzKSBiZWhhdmVzIGRpZmZlcmVudGx5XG4gICAgLy8gZnJvbSBDb2xsZWN0aW9uLmZpbmQodW5kZWZpbmVkKSAocmV0dXJuIDAgZG9jcykuICBzbyBiZVxuICAgIC8vIGNhcmVmdWwgYWJvdXQgdGhlIGxlbmd0aCBvZiBhcmd1bWVudHMuXG4gICAgcmV0dXJuIHRoaXMuX2NvbGxlY3Rpb24uZmluZChcbiAgICAgIHRoaXMuX2dldEZpbmRTZWxlY3RvcihhcmdzKSxcbiAgICAgIHRoaXMuX2dldEZpbmRPcHRpb25zKGFyZ3MpXG4gICAgKTtcbiAgfSxcblxuICAvKipcbiAgICogQHN1bW1hcnkgRmluZHMgdGhlIGZpcnN0IGRvY3VtZW50IHRoYXQgbWF0Y2hlcyB0aGUgc2VsZWN0b3IsIGFzIG9yZGVyZWQgYnkgc29ydCBhbmQgc2tpcCBvcHRpb25zLiBSZXR1cm5zIGB1bmRlZmluZWRgIGlmIG5vIG1hdGNoaW5nIGRvY3VtZW50IGlzIGZvdW5kLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCBmaW5kT25lXG4gICAqIEBtZW1iZXJPZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge01vbmdvU2VsZWN0b3J9IFtzZWxlY3Rvcl0gQSBxdWVyeSBkZXNjcmliaW5nIHRoZSBkb2N1bWVudHMgdG8gZmluZFxuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdXG4gICAqIEBwYXJhbSB7TW9uZ29Tb3J0U3BlY2lmaWVyfSBvcHRpb25zLnNvcnQgU29ydCBvcmRlciAoZGVmYXVsdDogbmF0dXJhbCBvcmRlcilcbiAgICogQHBhcmFtIHtOdW1iZXJ9IG9wdGlvbnMuc2tpcCBOdW1iZXIgb2YgcmVzdWx0cyB0byBza2lwIGF0IHRoZSBiZWdpbm5pbmdcbiAgICogQHBhcmFtIHtNb25nb0ZpZWxkU3BlY2lmaWVyfSBvcHRpb25zLmZpZWxkcyBEaWN0aW9uYXJ5IG9mIGZpZWxkcyB0byByZXR1cm4gb3IgZXhjbHVkZS5cbiAgICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLnJlYWN0aXZlIChDbGllbnQgb25seSkgRGVmYXVsdCB0cnVlOyBwYXNzIGZhbHNlIHRvIGRpc2FibGUgcmVhY3Rpdml0eVxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBvcHRpb25zLnRyYW5zZm9ybSBPdmVycmlkZXMgYHRyYW5zZm9ybWAgb24gdGhlIFtgQ29sbGVjdGlvbmBdKCNjb2xsZWN0aW9ucykgZm9yIHRoaXMgY3Vyc29yLiAgUGFzcyBgbnVsbGAgdG8gZGlzYWJsZSB0cmFuc2Zvcm1hdGlvbi5cbiAgICogQHJldHVybnMge09iamVjdH1cbiAgICovXG4gIGZpbmRPbmUoLi4uYXJncykge1xuICAgIHJldHVybiB0aGlzLl9jb2xsZWN0aW9uLmZpbmRPbmUoXG4gICAgICB0aGlzLl9nZXRGaW5kU2VsZWN0b3IoYXJncyksXG4gICAgICB0aGlzLl9nZXRGaW5kT3B0aW9ucyhhcmdzKVxuICAgICk7XG4gIH1cbn0pO1xuXG5PYmplY3QuYXNzaWduKE1vbmdvLkNvbGxlY3Rpb24sIHtcbiAgX3B1Ymxpc2hDdXJzb3IoY3Vyc29yLCBzdWIsIGNvbGxlY3Rpb24pIHtcbiAgICB2YXIgb2JzZXJ2ZUhhbmRsZSA9IGN1cnNvci5vYnNlcnZlQ2hhbmdlcyh7XG4gICAgICBhZGRlZDogZnVuY3Rpb24gKGlkLCBmaWVsZHMpIHtcbiAgICAgICAgc3ViLmFkZGVkKGNvbGxlY3Rpb24sIGlkLCBmaWVsZHMpO1xuICAgICAgfSxcbiAgICAgIGNoYW5nZWQ6IGZ1bmN0aW9uIChpZCwgZmllbGRzKSB7XG4gICAgICAgIHN1Yi5jaGFuZ2VkKGNvbGxlY3Rpb24sIGlkLCBmaWVsZHMpO1xuICAgICAgfSxcbiAgICAgIHJlbW92ZWQ6IGZ1bmN0aW9uIChpZCkge1xuICAgICAgICBzdWIucmVtb3ZlZChjb2xsZWN0aW9uLCBpZCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBXZSBkb24ndCBjYWxsIHN1Yi5yZWFkeSgpIGhlcmU6IGl0IGdldHMgY2FsbGVkIGluIGxpdmVkYXRhX3NlcnZlciwgYWZ0ZXJcbiAgICAvLyBwb3NzaWJseSBjYWxsaW5nIF9wdWJsaXNoQ3Vyc29yIG9uIG11bHRpcGxlIHJldHVybmVkIGN1cnNvcnMuXG5cbiAgICAvLyByZWdpc3RlciBzdG9wIGNhbGxiYWNrIChleHBlY3RzIGxhbWJkYSB3LyBubyBhcmdzKS5cbiAgICBzdWIub25TdG9wKGZ1bmN0aW9uICgpIHtcbiAgICAgIG9ic2VydmVIYW5kbGUuc3RvcCgpO1xuICAgIH0pO1xuXG4gICAgLy8gcmV0dXJuIHRoZSBvYnNlcnZlSGFuZGxlIGluIGNhc2UgaXQgbmVlZHMgdG8gYmUgc3RvcHBlZCBlYXJseVxuICAgIHJldHVybiBvYnNlcnZlSGFuZGxlO1xuICB9LFxuXG4gIC8vIHByb3RlY3QgYWdhaW5zdCBkYW5nZXJvdXMgc2VsZWN0b3JzLiAgZmFsc2V5IGFuZCB7X2lkOiBmYWxzZXl9IGFyZSBib3RoXG4gIC8vIGxpa2VseSBwcm9ncmFtbWVyIGVycm9yLCBhbmQgbm90IHdoYXQgeW91IHdhbnQsIHBhcnRpY3VsYXJseSBmb3IgZGVzdHJ1Y3RpdmVcbiAgLy8gb3BlcmF0aW9ucy4gSWYgYSBmYWxzZXkgX2lkIGlzIHNlbnQgaW4sIGEgbmV3IHN0cmluZyBfaWQgd2lsbCBiZVxuICAvLyBnZW5lcmF0ZWQgYW5kIHJldHVybmVkOyBpZiBhIGZhbGxiYWNrSWQgaXMgcHJvdmlkZWQsIGl0IHdpbGwgYmUgcmV0dXJuZWRcbiAgLy8gaW5zdGVhZC5cbiAgX3Jld3JpdGVTZWxlY3RvcihzZWxlY3RvciwgeyBmYWxsYmFja0lkIH0gPSB7fSkge1xuICAgIC8vIHNob3J0aGFuZCAtLSBzY2FsYXJzIG1hdGNoIF9pZFxuICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX3NlbGVjdG9ySXNJZChzZWxlY3RvcikpXG4gICAgICBzZWxlY3RvciA9IHtfaWQ6IHNlbGVjdG9yfTtcblxuICAgIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdG9yKSkge1xuICAgICAgLy8gVGhpcyBpcyBjb25zaXN0ZW50IHdpdGggdGhlIE1vbmdvIGNvbnNvbGUgaXRzZWxmOyBpZiB3ZSBkb24ndCBkbyB0aGlzXG4gICAgICAvLyBjaGVjayBwYXNzaW5nIGFuIGVtcHR5IGFycmF5IGVuZHMgdXAgc2VsZWN0aW5nIGFsbCBpdGVtc1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTW9uZ28gc2VsZWN0b3IgY2FuJ3QgYmUgYW4gYXJyYXkuXCIpO1xuICAgIH1cblxuICAgIGlmICghc2VsZWN0b3IgfHwgKCgnX2lkJyBpbiBzZWxlY3RvcikgJiYgIXNlbGVjdG9yLl9pZCkpIHtcbiAgICAgIC8vIGNhbid0IG1hdGNoIGFueXRoaW5nXG4gICAgICByZXR1cm4geyBfaWQ6IGZhbGxiYWNrSWQgfHwgUmFuZG9tLmlkKCkgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gc2VsZWN0b3I7XG4gIH1cbn0pO1xuXG5PYmplY3QuYXNzaWduKE1vbmdvLkNvbGxlY3Rpb24ucHJvdG90eXBlLCB7XG4gIC8vICdpbnNlcnQnIGltbWVkaWF0ZWx5IHJldHVybnMgdGhlIGluc2VydGVkIGRvY3VtZW50J3MgbmV3IF9pZC5cbiAgLy8gVGhlIG90aGVycyByZXR1cm4gdmFsdWVzIGltbWVkaWF0ZWx5IGlmIHlvdSBhcmUgaW4gYSBzdHViLCBhbiBpbi1tZW1vcnlcbiAgLy8gdW5tYW5hZ2VkIGNvbGxlY3Rpb24sIG9yIGEgbW9uZ28tYmFja2VkIGNvbGxlY3Rpb24gYW5kIHlvdSBkb24ndCBwYXNzIGFcbiAgLy8gY2FsbGJhY2suICd1cGRhdGUnIGFuZCAncmVtb3ZlJyByZXR1cm4gdGhlIG51bWJlciBvZiBhZmZlY3RlZFxuICAvLyBkb2N1bWVudHMuICd1cHNlcnQnIHJldHVybnMgYW4gb2JqZWN0IHdpdGgga2V5cyAnbnVtYmVyQWZmZWN0ZWQnIGFuZCwgaWYgYW5cbiAgLy8gaW5zZXJ0IGhhcHBlbmVkLCAnaW5zZXJ0ZWRJZCcuXG4gIC8vXG4gIC8vIE90aGVyd2lzZSwgdGhlIHNlbWFudGljcyBhcmUgZXhhY3RseSBsaWtlIG90aGVyIG1ldGhvZHM6IHRoZXkgdGFrZVxuICAvLyBhIGNhbGxiYWNrIGFzIGFuIG9wdGlvbmFsIGxhc3QgYXJndW1lbnQ7IGlmIG5vIGNhbGxiYWNrIGlzXG4gIC8vIHByb3ZpZGVkLCB0aGV5IGJsb2NrIHVudGlsIHRoZSBvcGVyYXRpb24gaXMgY29tcGxldGUsIGFuZCB0aHJvdyBhblxuICAvLyBleGNlcHRpb24gaWYgaXQgZmFpbHM7IGlmIGEgY2FsbGJhY2sgaXMgcHJvdmlkZWQsIHRoZW4gdGhleSBkb24ndFxuICAvLyBuZWNlc3NhcmlseSBibG9jaywgYW5kIHRoZXkgY2FsbCB0aGUgY2FsbGJhY2sgd2hlbiB0aGV5IGZpbmlzaCB3aXRoIGVycm9yIGFuZFxuICAvLyByZXN1bHQgYXJndW1lbnRzLiAgKFRoZSBpbnNlcnQgbWV0aG9kIHByb3ZpZGVzIHRoZSBkb2N1bWVudCBJRCBhcyBpdHMgcmVzdWx0O1xuICAvLyB1cGRhdGUgYW5kIHJlbW92ZSBwcm92aWRlIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWQgZG9jcyBhcyB0aGUgcmVzdWx0OyB1cHNlcnRcbiAgLy8gcHJvdmlkZXMgYW4gb2JqZWN0IHdpdGggbnVtYmVyQWZmZWN0ZWQgYW5kIG1heWJlIGluc2VydGVkSWQuKVxuICAvL1xuICAvLyBPbiB0aGUgY2xpZW50LCBibG9ja2luZyBpcyBpbXBvc3NpYmxlLCBzbyBpZiBhIGNhbGxiYWNrXG4gIC8vIGlzbid0IHByb3ZpZGVkLCB0aGV5IGp1c3QgcmV0dXJuIGltbWVkaWF0ZWx5IGFuZCBhbnkgZXJyb3JcbiAgLy8gaW5mb3JtYXRpb24gaXMgbG9zdC5cbiAgLy9cbiAgLy8gVGhlcmUncyBvbmUgbW9yZSB0d2Vhay4gT24gdGhlIGNsaWVudCwgaWYgeW91IGRvbid0IHByb3ZpZGUgYVxuICAvLyBjYWxsYmFjaywgdGhlbiBpZiB0aGVyZSBpcyBhbiBlcnJvciwgYSBtZXNzYWdlIHdpbGwgYmUgbG9nZ2VkIHdpdGhcbiAgLy8gTWV0ZW9yLl9kZWJ1Zy5cbiAgLy9cbiAgLy8gVGhlIGludGVudCAodGhvdWdoIHRoaXMgaXMgYWN0dWFsbHkgZGV0ZXJtaW5lZCBieSB0aGUgdW5kZXJseWluZ1xuICAvLyBkcml2ZXJzKSBpcyB0aGF0IHRoZSBvcGVyYXRpb25zIHNob3VsZCBiZSBkb25lIHN5bmNocm9ub3VzbHksIG5vdFxuICAvLyBnZW5lcmF0aW5nIHRoZWlyIHJlc3VsdCB1bnRpbCB0aGUgZGF0YWJhc2UgaGFzIGFja25vd2xlZGdlZFxuICAvLyB0aGVtLiBJbiB0aGUgZnV0dXJlIG1heWJlIHdlIHNob3VsZCBwcm92aWRlIGEgZmxhZyB0byB0dXJuIHRoaXNcbiAgLy8gb2ZmLlxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBJbnNlcnQgYSBkb2N1bWVudCBpbiB0aGUgY29sbGVjdGlvbi4gIFJldHVybnMgaXRzIHVuaXF1ZSBfaWQuXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kICBpbnNlcnRcbiAgICogQG1lbWJlck9mIE1vbmdvLkNvbGxlY3Rpb25cbiAgICogQGluc3RhbmNlXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBkb2MgVGhlIGRvY3VtZW50IHRvIGluc2VydC4gTWF5IG5vdCB5ZXQgaGF2ZSBhbiBfaWQgYXR0cmlidXRlLCBpbiB3aGljaCBjYXNlIE1ldGVvciB3aWxsIGdlbmVyYXRlIG9uZSBmb3IgeW91LlxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBbY2FsbGJhY2tdIE9wdGlvbmFsLiAgSWYgcHJlc2VudCwgY2FsbGVkIHdpdGggYW4gZXJyb3Igb2JqZWN0IGFzIHRoZSBmaXJzdCBhcmd1bWVudCBhbmQsIGlmIG5vIGVycm9yLCB0aGUgX2lkIGFzIHRoZSBzZWNvbmQuXG4gICAqL1xuICBpbnNlcnQoZG9jLCBjYWxsYmFjaykge1xuICAgIC8vIE1ha2Ugc3VyZSB3ZSB3ZXJlIHBhc3NlZCBhIGRvY3VtZW50IHRvIGluc2VydFxuICAgIGlmICghZG9jKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbnNlcnQgcmVxdWlyZXMgYW4gYXJndW1lbnRcIik7XG4gICAgfVxuXG4gICAgLy8gTWFrZSBhIHNoYWxsb3cgY2xvbmUgb2YgdGhlIGRvY3VtZW50LCBwcmVzZXJ2aW5nIGl0cyBwcm90b3R5cGUuXG4gICAgZG9jID0gT2JqZWN0LmNyZWF0ZShcbiAgICAgIE9iamVjdC5nZXRQcm90b3R5cGVPZihkb2MpLFxuICAgICAgT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcnMoZG9jKVxuICAgICk7XG5cbiAgICBpZiAoJ19pZCcgaW4gZG9jKSB7XG4gICAgICBpZiAoISBkb2MuX2lkIHx8XG4gICAgICAgICAgISAodHlwZW9mIGRvYy5faWQgPT09ICdzdHJpbmcnIHx8XG4gICAgICAgICAgICAgZG9jLl9pZCBpbnN0YW5jZW9mIE1vbmdvLk9iamVjdElEKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJNZXRlb3IgcmVxdWlyZXMgZG9jdW1lbnQgX2lkIGZpZWxkcyB0byBiZSBub24tZW1wdHkgc3RyaW5ncyBvciBPYmplY3RJRHNcIik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGxldCBnZW5lcmF0ZUlkID0gdHJ1ZTtcblxuICAgICAgLy8gRG9uJ3QgZ2VuZXJhdGUgdGhlIGlkIGlmIHdlJ3JlIHRoZSBjbGllbnQgYW5kIHRoZSAnb3V0ZXJtb3N0JyBjYWxsXG4gICAgICAvLyBUaGlzIG9wdGltaXphdGlvbiBzYXZlcyB1cyBwYXNzaW5nIGJvdGggdGhlIHJhbmRvbVNlZWQgYW5kIHRoZSBpZFxuICAgICAgLy8gUGFzc2luZyBib3RoIGlzIHJlZHVuZGFudC5cbiAgICAgIGlmICh0aGlzLl9pc1JlbW90ZUNvbGxlY3Rpb24oKSkge1xuICAgICAgICBjb25zdCBlbmNsb3NpbmcgPSBERFAuX0N1cnJlbnRNZXRob2RJbnZvY2F0aW9uLmdldCgpO1xuICAgICAgICBpZiAoIWVuY2xvc2luZykge1xuICAgICAgICAgIGdlbmVyYXRlSWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoZ2VuZXJhdGVJZCkge1xuICAgICAgICBkb2MuX2lkID0gdGhpcy5fbWFrZU5ld0lEKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gT24gaW5zZXJ0cywgYWx3YXlzIHJldHVybiB0aGUgaWQgdGhhdCB3ZSBnZW5lcmF0ZWQ7IG9uIGFsbCBvdGhlclxuICAgIC8vIG9wZXJhdGlvbnMsIGp1c3QgcmV0dXJuIHRoZSByZXN1bHQgZnJvbSB0aGUgY29sbGVjdGlvbi5cbiAgICB2YXIgY2hvb3NlUmV0dXJuVmFsdWVGcm9tQ29sbGVjdGlvblJlc3VsdCA9IGZ1bmN0aW9uIChyZXN1bHQpIHtcbiAgICAgIGlmIChkb2MuX2lkKSB7XG4gICAgICAgIHJldHVybiBkb2MuX2lkO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggd2hhdCBpcyB0aGlzIGZvcj8/XG4gICAgICAvLyBJdCdzIHNvbWUgaXRlcmFjdGlvbiBiZXR3ZWVuIHRoZSBjYWxsYmFjayB0byBfY2FsbE11dGF0b3JNZXRob2QgYW5kXG4gICAgICAvLyB0aGUgcmV0dXJuIHZhbHVlIGNvbnZlcnNpb25cbiAgICAgIGRvYy5faWQgPSByZXN1bHQ7XG5cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcblxuICAgIGNvbnN0IHdyYXBwZWRDYWxsYmFjayA9IHdyYXBDYWxsYmFjayhcbiAgICAgIGNhbGxiYWNrLCBjaG9vc2VSZXR1cm5WYWx1ZUZyb21Db2xsZWN0aW9uUmVzdWx0KTtcblxuICAgIGlmICh0aGlzLl9pc1JlbW90ZUNvbGxlY3Rpb24oKSkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy5fY2FsbE11dGF0b3JNZXRob2QoXCJpbnNlcnRcIiwgW2RvY10sIHdyYXBwZWRDYWxsYmFjayk7XG4gICAgICByZXR1cm4gY2hvb3NlUmV0dXJuVmFsdWVGcm9tQ29sbGVjdGlvblJlc3VsdChyZXN1bHQpO1xuICAgIH1cblxuICAgIC8vIGl0J3MgbXkgY29sbGVjdGlvbi4gIGRlc2NlbmQgaW50byB0aGUgY29sbGVjdGlvbiBvYmplY3RcbiAgICAvLyBhbmQgcHJvcGFnYXRlIGFueSBleGNlcHRpb24uXG4gICAgdHJ5IHtcbiAgICAgIC8vIElmIHRoZSB1c2VyIHByb3ZpZGVkIGEgY2FsbGJhY2sgYW5kIHRoZSBjb2xsZWN0aW9uIGltcGxlbWVudHMgdGhpc1xuICAgICAgLy8gb3BlcmF0aW9uIGFzeW5jaHJvbm91c2x5LCB0aGVuIHF1ZXJ5UmV0IHdpbGwgYmUgdW5kZWZpbmVkLCBhbmQgdGhlXG4gICAgICAvLyByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCB0aHJvdWdoIHRoZSBjYWxsYmFjayBpbnN0ZWFkLlxuICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy5fY29sbGVjdGlvbi5pbnNlcnQoZG9jLCB3cmFwcGVkQ2FsbGJhY2spO1xuICAgICAgcmV0dXJuIGNob29zZVJldHVyblZhbHVlRnJvbUNvbGxlY3Rpb25SZXN1bHQocmVzdWx0KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IE1vZGlmeSBvbmUgb3IgbW9yZSBkb2N1bWVudHMgaW4gdGhlIGNvbGxlY3Rpb24uIFJldHVybnMgdGhlIG51bWJlciBvZiBtYXRjaGVkIGRvY3VtZW50cy5cbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEBtZXRob2QgdXBkYXRlXG4gICAqIEBtZW1iZXJPZiBNb25nby5Db2xsZWN0aW9uXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAcGFyYW0ge01vbmdvU2VsZWN0b3J9IHNlbGVjdG9yIFNwZWNpZmllcyB3aGljaCBkb2N1bWVudHMgdG8gbW9kaWZ5XG4gICAqIEBwYXJhbSB7TW9uZ29Nb2RpZmllcn0gbW9kaWZpZXIgU3BlY2lmaWVzIGhvdyB0byBtb2RpZnkgdGhlIGRvY3VtZW50c1xuICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdXG4gICAqIEBwYXJhbSB7Qm9vbGVhbn0gb3B0aW9ucy5tdWx0aSBUcnVlIHRvIG1vZGlmeSBhbGwgbWF0Y2hpbmcgZG9jdW1lbnRzOyBmYWxzZSB0byBvbmx5IG1vZGlmeSBvbmUgb2YgdGhlIG1hdGNoaW5nIGRvY3VtZW50cyAodGhlIGRlZmF1bHQpLlxuICAgKiBAcGFyYW0ge0Jvb2xlYW59IG9wdGlvbnMudXBzZXJ0IFRydWUgdG8gaW5zZXJ0IGEgZG9jdW1lbnQgaWYgbm8gbWF0Y2hpbmcgZG9jdW1lbnRzIGFyZSBmb3VuZC5cbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gW2NhbGxiYWNrXSBPcHRpb25hbC4gIElmIHByZXNlbnQsIGNhbGxlZCB3aXRoIGFuIGVycm9yIG9iamVjdCBhcyB0aGUgZmlyc3QgYXJndW1lbnQgYW5kLCBpZiBubyBlcnJvciwgdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2N1bWVudHMgYXMgdGhlIHNlY29uZC5cbiAgICovXG4gIHVwZGF0ZShzZWxlY3RvciwgbW9kaWZpZXIsIC4uLm9wdGlvbnNBbmRDYWxsYmFjaykge1xuICAgIGNvbnN0IGNhbGxiYWNrID0gcG9wQ2FsbGJhY2tGcm9tQXJncyhvcHRpb25zQW5kQ2FsbGJhY2spO1xuXG4gICAgLy8gV2UndmUgYWxyZWFkeSBwb3BwZWQgb2ZmIHRoZSBjYWxsYmFjaywgc28gd2UgYXJlIGxlZnQgd2l0aCBhbiBhcnJheVxuICAgIC8vIG9mIG9uZSBvciB6ZXJvIGl0ZW1zXG4gICAgY29uc3Qgb3B0aW9ucyA9IHsgLi4uKG9wdGlvbnNBbmRDYWxsYmFja1swXSB8fCBudWxsKSB9O1xuICAgIGxldCBpbnNlcnRlZElkO1xuICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMudXBzZXJ0KSB7XG4gICAgICAvLyBzZXQgYGluc2VydGVkSWRgIGlmIGFic2VudC4gIGBpbnNlcnRlZElkYCBpcyBhIE1ldGVvciBleHRlbnNpb24uXG4gICAgICBpZiAob3B0aW9ucy5pbnNlcnRlZElkKSB7XG4gICAgICAgIGlmICghKHR5cGVvZiBvcHRpb25zLmluc2VydGVkSWQgPT09ICdzdHJpbmcnIHx8IG9wdGlvbnMuaW5zZXJ0ZWRJZCBpbnN0YW5jZW9mIE1vbmdvLk9iamVjdElEKSlcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbnNlcnRlZElkIG11c3QgYmUgc3RyaW5nIG9yIE9iamVjdElEXCIpO1xuICAgICAgICBpbnNlcnRlZElkID0gb3B0aW9ucy5pbnNlcnRlZElkO1xuICAgICAgfSBlbHNlIGlmICghc2VsZWN0b3IgfHwgIXNlbGVjdG9yLl9pZCkge1xuICAgICAgICBpbnNlcnRlZElkID0gdGhpcy5fbWFrZU5ld0lEKCk7XG4gICAgICAgIG9wdGlvbnMuZ2VuZXJhdGVkSWQgPSB0cnVlO1xuICAgICAgICBvcHRpb25zLmluc2VydGVkSWQgPSBpbnNlcnRlZElkO1xuICAgICAgfVxuICAgIH1cblxuICAgIHNlbGVjdG9yID1cbiAgICAgIE1vbmdvLkNvbGxlY3Rpb24uX3Jld3JpdGVTZWxlY3RvcihzZWxlY3RvciwgeyBmYWxsYmFja0lkOiBpbnNlcnRlZElkIH0pO1xuXG4gICAgY29uc3Qgd3JhcHBlZENhbGxiYWNrID0gd3JhcENhbGxiYWNrKGNhbGxiYWNrKTtcblxuICAgIGlmICh0aGlzLl9pc1JlbW90ZUNvbGxlY3Rpb24oKSkge1xuICAgICAgY29uc3QgYXJncyA9IFtcbiAgICAgICAgc2VsZWN0b3IsXG4gICAgICAgIG1vZGlmaWVyLFxuICAgICAgICBvcHRpb25zXG4gICAgICBdO1xuXG4gICAgICByZXR1cm4gdGhpcy5fY2FsbE11dGF0b3JNZXRob2QoXCJ1cGRhdGVcIiwgYXJncywgd3JhcHBlZENhbGxiYWNrKTtcbiAgICB9XG5cbiAgICAvLyBpdCdzIG15IGNvbGxlY3Rpb24uICBkZXNjZW5kIGludG8gdGhlIGNvbGxlY3Rpb24gb2JqZWN0XG4gICAgLy8gYW5kIHByb3BhZ2F0ZSBhbnkgZXhjZXB0aW9uLlxuICAgIHRyeSB7XG4gICAgICAvLyBJZiB0aGUgdXNlciBwcm92aWRlZCBhIGNhbGxiYWNrIGFuZCB0aGUgY29sbGVjdGlvbiBpbXBsZW1lbnRzIHRoaXNcbiAgICAgIC8vIG9wZXJhdGlvbiBhc3luY2hyb25vdXNseSwgdGhlbiBxdWVyeVJldCB3aWxsIGJlIHVuZGVmaW5lZCwgYW5kIHRoZVxuICAgICAgLy8gcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgdGhyb3VnaCB0aGUgY2FsbGJhY2sgaW5zdGVhZC5cbiAgICAgIHJldHVybiB0aGlzLl9jb2xsZWN0aW9uLnVwZGF0ZShcbiAgICAgICAgc2VsZWN0b3IsIG1vZGlmaWVyLCBvcHRpb25zLCB3cmFwcGVkQ2FsbGJhY2spO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgICBjYWxsYmFjayhlKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfSxcblxuICAvKipcbiAgICogQHN1bW1hcnkgUmVtb3ZlIGRvY3VtZW50cyBmcm9tIHRoZSBjb2xsZWN0aW9uXG4gICAqIEBsb2N1cyBBbnl3aGVyZVxuICAgKiBAbWV0aG9kIHJlbW92ZVxuICAgKiBAbWVtYmVyT2YgTW9uZ28uQ29sbGVjdGlvblxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtNb25nb1NlbGVjdG9yfSBzZWxlY3RvciBTcGVjaWZpZXMgd2hpY2ggZG9jdW1lbnRzIHRvIHJlbW92ZVxuICAgKiBAcGFyYW0ge0Z1bmN0aW9ufSBbY2FsbGJhY2tdIE9wdGlvbmFsLiAgSWYgcHJlc2VudCwgY2FsbGVkIHdpdGggYW4gZXJyb3Igb2JqZWN0IGFzIGl0cyBhcmd1bWVudC5cbiAgICovXG4gIHJlbW92ZShzZWxlY3RvciwgY2FsbGJhY2spIHtcbiAgICBzZWxlY3RvciA9IE1vbmdvLkNvbGxlY3Rpb24uX3Jld3JpdGVTZWxlY3RvcihzZWxlY3Rvcik7XG5cbiAgICBjb25zdCB3cmFwcGVkQ2FsbGJhY2sgPSB3cmFwQ2FsbGJhY2soY2FsbGJhY2spO1xuXG4gICAgaWYgKHRoaXMuX2lzUmVtb3RlQ29sbGVjdGlvbigpKSB7XG4gICAgICByZXR1cm4gdGhpcy5fY2FsbE11dGF0b3JNZXRob2QoXCJyZW1vdmVcIiwgW3NlbGVjdG9yXSwgd3JhcHBlZENhbGxiYWNrKTtcbiAgICB9XG5cbiAgICAvLyBpdCdzIG15IGNvbGxlY3Rpb24uICBkZXNjZW5kIGludG8gdGhlIGNvbGxlY3Rpb24gb2JqZWN0XG4gICAgLy8gYW5kIHByb3BhZ2F0ZSBhbnkgZXhjZXB0aW9uLlxuICAgIHRyeSB7XG4gICAgICAvLyBJZiB0aGUgdXNlciBwcm92aWRlZCBhIGNhbGxiYWNrIGFuZCB0aGUgY29sbGVjdGlvbiBpbXBsZW1lbnRzIHRoaXNcbiAgICAgIC8vIG9wZXJhdGlvbiBhc3luY2hyb25vdXNseSwgdGhlbiBxdWVyeVJldCB3aWxsIGJlIHVuZGVmaW5lZCwgYW5kIHRoZVxuICAgICAgLy8gcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgdGhyb3VnaCB0aGUgY2FsbGJhY2sgaW5zdGVhZC5cbiAgICAgIHJldHVybiB0aGlzLl9jb2xsZWN0aW9uLnJlbW92ZShzZWxlY3Rvciwgd3JhcHBlZENhbGxiYWNrKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgY2FsbGJhY2soZSk7XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfVxuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH0sXG5cbiAgLy8gRGV0ZXJtaW5lIGlmIHRoaXMgY29sbGVjdGlvbiBpcyBzaW1wbHkgYSBtaW5pbW9uZ28gcmVwcmVzZW50YXRpb24gb2YgYSByZWFsXG4gIC8vIGRhdGFiYXNlIG9uIGFub3RoZXIgc2VydmVyXG4gIF9pc1JlbW90ZUNvbGxlY3Rpb24oKSB7XG4gICAgLy8gWFhYIHNlZSAjTWV0ZW9yU2VydmVyTnVsbFxuICAgIHJldHVybiB0aGlzLl9jb25uZWN0aW9uICYmIHRoaXMuX2Nvbm5lY3Rpb24gIT09IE1ldGVvci5zZXJ2ZXI7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IE1vZGlmeSBvbmUgb3IgbW9yZSBkb2N1bWVudHMgaW4gdGhlIGNvbGxlY3Rpb24sIG9yIGluc2VydCBvbmUgaWYgbm8gbWF0Y2hpbmcgZG9jdW1lbnRzIHdlcmUgZm91bmQuIFJldHVybnMgYW4gb2JqZWN0IHdpdGgga2V5cyBgbnVtYmVyQWZmZWN0ZWRgICh0aGUgbnVtYmVyIG9mIGRvY3VtZW50cyBtb2RpZmllZCkgIGFuZCBgaW5zZXJ0ZWRJZGAgKHRoZSB1bmlxdWUgX2lkIG9mIHRoZSBkb2N1bWVudCB0aGF0IHdhcyBpbnNlcnRlZCwgaWYgYW55KS5cbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEBwYXJhbSB7TW9uZ29TZWxlY3Rvcn0gc2VsZWN0b3IgU3BlY2lmaWVzIHdoaWNoIGRvY3VtZW50cyB0byBtb2RpZnlcbiAgICogQHBhcmFtIHtNb25nb01vZGlmaWVyfSBtb2RpZmllciBTcGVjaWZpZXMgaG93IHRvIG1vZGlmeSB0aGUgZG9jdW1lbnRzXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc11cbiAgICogQHBhcmFtIHtCb29sZWFufSBvcHRpb25zLm11bHRpIFRydWUgdG8gbW9kaWZ5IGFsbCBtYXRjaGluZyBkb2N1bWVudHM7IGZhbHNlIHRvIG9ubHkgbW9kaWZ5IG9uZSBvZiB0aGUgbWF0Y2hpbmcgZG9jdW1lbnRzICh0aGUgZGVmYXVsdCkuXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IFtjYWxsYmFja10gT3B0aW9uYWwuICBJZiBwcmVzZW50LCBjYWxsZWQgd2l0aCBhbiBlcnJvciBvYmplY3QgYXMgdGhlIGZpcnN0IGFyZ3VtZW50IGFuZCwgaWYgbm8gZXJyb3IsIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWQgZG9jdW1lbnRzIGFzIHRoZSBzZWNvbmQuXG4gICAqL1xuICB1cHNlcnQoc2VsZWN0b3IsIG1vZGlmaWVyLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICAgIGlmICghIGNhbGxiYWNrICYmIHR5cGVvZiBvcHRpb25zID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy51cGRhdGUoc2VsZWN0b3IsIG1vZGlmaWVyLCB7XG4gICAgICAuLi5vcHRpb25zLFxuICAgICAgX3JldHVybk9iamVjdDogdHJ1ZSxcbiAgICAgIHVwc2VydDogdHJ1ZSxcbiAgICB9LCBjYWxsYmFjayk7XG4gIH0sXG5cbiAgLy8gV2UnbGwgYWN0dWFsbHkgZGVzaWduIGFuIGluZGV4IEFQSSBsYXRlci4gRm9yIG5vdywgd2UganVzdCBwYXNzIHRocm91Z2ggdG9cbiAgLy8gTW9uZ28ncywgYnV0IG1ha2UgaXQgc3luY2hyb25vdXMuXG4gIF9lbnN1cmVJbmRleChpbmRleCwgb3B0aW9ucykge1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICBpZiAoIXNlbGYuX2NvbGxlY3Rpb24uX2Vuc3VyZUluZGV4KVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCBfZW5zdXJlSW5kZXggb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIHNlbGYuX2NvbGxlY3Rpb24uX2Vuc3VyZUluZGV4KGluZGV4LCBvcHRpb25zKTtcbiAgfSxcblxuICBfZHJvcEluZGV4KGluZGV4KSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghc2VsZi5fY29sbGVjdGlvbi5fZHJvcEluZGV4KVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCBfZHJvcEluZGV4IG9uIHNlcnZlciBjb2xsZWN0aW9uc1wiKTtcbiAgICBzZWxmLl9jb2xsZWN0aW9uLl9kcm9wSW5kZXgoaW5kZXgpO1xuICB9LFxuXG4gIF9kcm9wQ29sbGVjdGlvbigpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCFzZWxmLl9jb2xsZWN0aW9uLmRyb3BDb2xsZWN0aW9uKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCBfZHJvcENvbGxlY3Rpb24gb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIHNlbGYuX2NvbGxlY3Rpb24uZHJvcENvbGxlY3Rpb24oKTtcbiAgfSxcblxuICBfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbihieXRlU2l6ZSwgbWF4RG9jdW1lbnRzKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghc2VsZi5fY29sbGVjdGlvbi5fY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbilcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkNhbiBvbmx5IGNhbGwgX2NyZWF0ZUNhcHBlZENvbGxlY3Rpb24gb24gc2VydmVyIGNvbGxlY3Rpb25zXCIpO1xuICAgIHNlbGYuX2NvbGxlY3Rpb24uX2NyZWF0ZUNhcHBlZENvbGxlY3Rpb24oYnl0ZVNpemUsIG1heERvY3VtZW50cyk7XG4gIH0sXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJldHVybnMgdGhlIFtgQ29sbGVjdGlvbmBdKGh0dHA6Ly9tb25nb2RiLmdpdGh1Yi5pby9ub2RlLW1vbmdvZGItbmF0aXZlLzIuMi9hcGkvQ29sbGVjdGlvbi5odG1sKSBvYmplY3QgY29ycmVzcG9uZGluZyB0byB0aGlzIGNvbGxlY3Rpb24gZnJvbSB0aGUgW25wbSBgbW9uZ29kYmAgZHJpdmVyIG1vZHVsZV0oaHR0cHM6Ly93d3cubnBtanMuY29tL3BhY2thZ2UvbW9uZ29kYikgd2hpY2ggaXMgd3JhcHBlZCBieSBgTW9uZ28uQ29sbGVjdGlvbmAuXG4gICAqIEBsb2N1cyBTZXJ2ZXJcbiAgICovXG4gIHJhd0NvbGxlY3Rpb24oKSB7XG4gICAgdmFyIHNlbGYgPSB0aGlzO1xuICAgIGlmICghIHNlbGYuX2NvbGxlY3Rpb24ucmF3Q29sbGVjdGlvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQ2FuIG9ubHkgY2FsbCByYXdDb2xsZWN0aW9uIG9uIHNlcnZlciBjb2xsZWN0aW9uc1wiKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlbGYuX2NvbGxlY3Rpb24ucmF3Q29sbGVjdGlvbigpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBSZXR1cm5zIHRoZSBbYERiYF0oaHR0cDovL21vbmdvZGIuZ2l0aHViLmlvL25vZGUtbW9uZ29kYi1uYXRpdmUvMi4yL2FwaS9EYi5odG1sKSBvYmplY3QgY29ycmVzcG9uZGluZyB0byB0aGlzIGNvbGxlY3Rpb24ncyBkYXRhYmFzZSBjb25uZWN0aW9uIGZyb20gdGhlIFtucG0gYG1vbmdvZGJgIGRyaXZlciBtb2R1bGVdKGh0dHBzOi8vd3d3Lm5wbWpzLmNvbS9wYWNrYWdlL21vbmdvZGIpIHdoaWNoIGlzIHdyYXBwZWQgYnkgYE1vbmdvLkNvbGxlY3Rpb25gLlxuICAgKiBAbG9jdXMgU2VydmVyXG4gICAqL1xuICByYXdEYXRhYmFzZSgpIHtcbiAgICB2YXIgc2VsZiA9IHRoaXM7XG4gICAgaWYgKCEgKHNlbGYuX2RyaXZlci5tb25nbyAmJiBzZWxmLl9kcml2ZXIubW9uZ28uZGIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDYW4gb25seSBjYWxsIHJhd0RhdGFiYXNlIG9uIHNlcnZlciBjb2xsZWN0aW9uc1wiKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlbGYuX2RyaXZlci5tb25nby5kYjtcbiAgfVxufSk7XG5cbi8vIENvbnZlcnQgdGhlIGNhbGxiYWNrIHRvIG5vdCByZXR1cm4gYSByZXN1bHQgaWYgdGhlcmUgaXMgYW4gZXJyb3JcbmZ1bmN0aW9uIHdyYXBDYWxsYmFjayhjYWxsYmFjaywgY29udmVydFJlc3VsdCkge1xuICByZXR1cm4gY2FsbGJhY2sgJiYgZnVuY3Rpb24gKGVycm9yLCByZXN1bHQpIHtcbiAgICBpZiAoZXJyb3IpIHtcbiAgICAgIGNhbGxiYWNrKGVycm9yKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBjb252ZXJ0UmVzdWx0ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIGNvbnZlcnRSZXN1bHQocmVzdWx0KSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdCk7XG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIEBzdW1tYXJ5IENyZWF0ZSBhIE1vbmdvLXN0eWxlIGBPYmplY3RJRGAuICBJZiB5b3UgZG9uJ3Qgc3BlY2lmeSBhIGBoZXhTdHJpbmdgLCB0aGUgYE9iamVjdElEYCB3aWxsIGdlbmVyYXRlZCByYW5kb21seSAobm90IHVzaW5nIE1vbmdvREIncyBJRCBjb25zdHJ1Y3Rpb24gcnVsZXMpLlxuICogQGxvY3VzIEFueXdoZXJlXG4gKiBAY2xhc3NcbiAqIEBwYXJhbSB7U3RyaW5nfSBbaGV4U3RyaW5nXSBPcHRpb25hbC4gIFRoZSAyNC1jaGFyYWN0ZXIgaGV4YWRlY2ltYWwgY29udGVudHMgb2YgdGhlIE9iamVjdElEIHRvIGNyZWF0ZVxuICovXG5Nb25nby5PYmplY3RJRCA9IE1vbmdvSUQuT2JqZWN0SUQ7XG5cbi8qKlxuICogQHN1bW1hcnkgVG8gY3JlYXRlIGEgY3Vyc29yLCB1c2UgZmluZC4gVG8gYWNjZXNzIHRoZSBkb2N1bWVudHMgaW4gYSBjdXJzb3IsIHVzZSBmb3JFYWNoLCBtYXAsIG9yIGZldGNoLlxuICogQGNsYXNzXG4gKiBAaW5zdGFuY2VOYW1lIGN1cnNvclxuICovXG5Nb25nby5DdXJzb3IgPSBMb2NhbENvbGxlY3Rpb24uQ3Vyc29yO1xuXG4vKipcbiAqIEBkZXByZWNhdGVkIGluIDAuOS4xXG4gKi9cbk1vbmdvLkNvbGxlY3Rpb24uQ3Vyc29yID0gTW9uZ28uQ3Vyc29yO1xuXG4vKipcbiAqIEBkZXByZWNhdGVkIGluIDAuOS4xXG4gKi9cbk1vbmdvLkNvbGxlY3Rpb24uT2JqZWN0SUQgPSBNb25nby5PYmplY3RJRDtcblxuLyoqXG4gKiBAZGVwcmVjYXRlZCBpbiAwLjkuMVxuICovXG5NZXRlb3IuQ29sbGVjdGlvbiA9IE1vbmdvLkNvbGxlY3Rpb247XG5cbi8vIEFsbG93IGRlbnkgc3R1ZmYgaXMgbm93IGluIHRoZSBhbGxvdy1kZW55IHBhY2thZ2Vcbk9iamVjdC5hc3NpZ24oXG4gIE1ldGVvci5Db2xsZWN0aW9uLnByb3RvdHlwZSxcbiAgQWxsb3dEZW55LkNvbGxlY3Rpb25Qcm90b3R5cGVcbik7XG5cbmZ1bmN0aW9uIHBvcENhbGxiYWNrRnJvbUFyZ3MoYXJncykge1xuICAvLyBQdWxsIG9mZiBhbnkgY2FsbGJhY2sgKG9yIHBlcmhhcHMgYSAnY2FsbGJhY2snIHZhcmlhYmxlIHRoYXQgd2FzIHBhc3NlZFxuICAvLyBpbiB1bmRlZmluZWQsIGxpa2UgaG93ICd1cHNlcnQnIGRvZXMgaXQpLlxuICBpZiAoYXJncy5sZW5ndGggJiZcbiAgICAgIChhcmdzW2FyZ3MubGVuZ3RoIC0gMV0gPT09IHVuZGVmaW5lZCB8fFxuICAgICAgIGFyZ3NbYXJncy5sZW5ndGggLSAxXSBpbnN0YW5jZW9mIEZ1bmN0aW9uKSkge1xuICAgIHJldHVybiBhcmdzLnBvcCgpO1xuICB9XG59XG4iLCIvKipcbiAqIEBzdW1tYXJ5IEFsbG93cyBmb3IgdXNlciBzcGVjaWZpZWQgY29ubmVjdGlvbiBvcHRpb25zXG4gKiBAZXhhbXBsZSBodHRwOi8vbW9uZ29kYi5naXRodWIuaW8vbm9kZS1tb25nb2RiLW5hdGl2ZS8yLjIvcmVmZXJlbmNlL2Nvbm5lY3RpbmcvY29ubmVjdGlvbi1zZXR0aW5ncy9cbiAqIEBsb2N1cyBTZXJ2ZXJcbiAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIFVzZXIgc3BlY2lmaWVkIE1vbmdvIGNvbm5lY3Rpb24gb3B0aW9uc1xuICovXG5Nb25nby5zZXRDb25uZWN0aW9uT3B0aW9ucyA9IGZ1bmN0aW9uIHNldENvbm5lY3Rpb25PcHRpb25zIChvcHRpb25zKSB7XG4gIGNoZWNrKG9wdGlvbnMsIE9iamVjdCk7XG4gIE1vbmdvLl9jb25uZWN0aW9uT3B0aW9ucyA9IG9wdGlvbnM7XG59OyJdfQ==

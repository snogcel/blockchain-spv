'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };

var EventEmitter = require('events').EventEmitter;
var async = require('async');
var u = require('bitcoin-util');
var DefaultBlock = require('bitcore-lib-dash').BlockHeader
// var DefaultBlock = require('bitcore-lib').BlockHeader;
var from = require('from2').obj;
var to = require('flush-write-stream').obj;
var inherits = require('inherits');
var BlockStore = require('./blockStore.js');
var HeaderStream = require('./headerStream.js');
var assign = require('object-assign');
if (!setImmediate) require('setimmediate');

var storeClosedError = new Error('Store is closed');

function validParameters(params) {
  return _typeof(params.genesisHeader) === 'object' && typeof params.shouldRetarget === 'function' && typeof params.calculateTarget === 'function' && typeof params.miningHash === 'function';
}

var Blockchain = module.exports = function (params, db, opts) {
  if (!params || !validParameters(params)) {
    throw new Error('Invalid network parameters');
  }
  if (!db) throw new Error('Must specify db');
  this.params = params;
  opts = opts || {};

  var Block = params.Block || DefaultBlock;

  function blockFromObject(obj) {
    return new Block(obj);
  }

  // function blockFromObject (obj) {
  //  return assign(new Block(), obj)
  // }

  var genesisHeader = blockFromObject(params.genesisHeader);
  this.genesis = this.tip = {
    height: 0,
    hash: genesisHeader.getHash(),
    header: genesisHeader
  };

  if (params.checkpoints && !opts.ignoreCheckpoints) {
    var lastCheckpoint = params.checkpoints[params.checkpoints.length - 1];
    this.checkpoint = {
      height: lastCheckpoint.height,
      header: blockFromObject(lastCheckpoint.header)
    };
    this.checkpoint.hash = this.checkpoint.header.getHash();
    this.tip = this.checkpoint;
  }

  this.initialized = false;
  this.closed = false;
  this.adding = false;

  this.store = new BlockStore({ db: db, Block: Block });
  this._initialize();
};
inherits(Blockchain, EventEmitter);

Blockchain.prototype._initialize = function () {
  var _this = this;

  if (this.initialized) {
    return this._error(new Error('Already initialized'));
  }

  this._initStore(function (err) {
    if (err) return _this._error(err);
    _this.store.getTip(function (err, tip) {
      if (err && err.name !== 'NotFoundError') return _this._error(err);
      if (tip) _this.tip = tip;
      _this.initialized = true;
      _this.emit('ready');
    });
  });
};

Blockchain.prototype._initStore = function (cb) {
  var _this2 = this;

  var putIfNotFound = function putIfNotFound(block) {
    return function (cb) {
      _this2.store.get(block.hash, function (err) {
        if (err && !err.notFound) return cb(err);
        if (_this2.closed || _this2.store.isClosed()) return cb(storeClosedError);
        _this2.store.put(block, cb);
      });
    };
  };

  var tasks = [putIfNotFound(this.genesis)];
  if (this.checkpoint) tasks.push(putIfNotFound(this.checkpoint));
  async.parallel(tasks, cb);
};

Blockchain.prototype.onceReady = function (cb) {
  if (this.initialized) return cb();
  this.once('ready', cb);
};

Blockchain.prototype.close = function (cb) {
  var _this3 = this;

  this.onceReady(function () {
    _this3.closed = true;
    _this3.store.close(cb);
  });
};

Blockchain.prototype.getTip = function () {
  return this.tip;
};

Blockchain.prototype.getPath = function (from, to, cb) {
  var _this4 = this;

  var output = {
    add: [],
    remove: [],
    fork: null
  };

  var top, bottom, down;
  if (from.height > to.height) {
    top = from;
    bottom = to;
    down = true;
  } else {
    top = to;
    bottom = from;
    down = false;
  }

  var addTraversedBlock = function addTraversedBlock(block) {
    if (down && block.header.getHash().compare(to.header.getHash()) !== 0) {
      output.remove.push(block);
    } else if (!down && block.header.getHash().compare(from.header.getHash()) !== 0) {
      output.add.unshift(block);
    }
  };

  // traverse down from the higher block to the lower block
  var traverseDown = function traverseDown(err, block) {
    if (err) return cb(err);
    if (block.height === bottom.height) {
      // we traversed down to the lower height
      if (block.header.getHash().compare(bottom.header.getHash()) === 0) {
        // the blocks are the same, there was no fork
        addTraversedBlock(block);
        return cb(null, output);
      }
      // the blocks are not the same, so we need to traverse down to find a fork
      return traverseToFork(block, bottom);
    }
    addTraversedBlock(block);
    _this4.getBlock(block.header.prevHash, traverseDown);
  };
  traverseDown(null, top);

  // traverse down from both blocks until we find one block that is the same
  var traverseToFork = function traverseToFork(left, right) {
    if (left.height === 0 || right.height === 0) {
      // we got all the way to two different genesis blocks,
      // the blocks don't have a path between them
      return cb(new Error('Blocks are not in the same chain'));
    }

    output.remove.push(down ? left : right);
    output.add.unshift(down ? right : left);

    _this4.getBlock(left.header.prevHash, function (err, left) {
      if (err) return cb(err);
      _this4.getBlock(right.header.prevHash, function (err, right) {
        if (err) return cb(err);
        if (left.header.getHash().compare(right.header.getHash()) === 0) {
          output.fork = left;
          return cb(null, output);
        }
        traverseToFork(left, right);
      });
    });
  };
};

Blockchain.prototype.getPathToTip = function (from, cb) {
  this.getPath(from, this.tip, cb);
};

Blockchain.prototype.getBlock = function (hash, cb) {
  var _this5 = this;

  if (!Buffer.isBuffer(hash)) {
    return cb(new Error('"hash" must be a Buffer'));
  }
  if (!this.initialized) {
    this.once('ready', function () {
      return _this5.getBlock(hash, cb);
    });
    return;
  }
  this.store.get(hash, cb);
};

Blockchain.prototype.getBlockAtTime = function (time, cb) {
  var _this6 = this;

  var output = this.tip;
  var traverse = function traverse(err, block) {
    if (err) return cb(err);
    if (block.header.time <= time) return cb(null, output);
    if (block.header.time >= time) output = block;
    if (block.height === 0) return cb(null, output);
    _this6.getBlock(block.header.prevHash, traverse);
  };
  traverse(null, this.tip);
};

Blockchain.prototype.getBlockAtHeight = function (height, cb) {
  var _this7 = this;

  if (height > this.tip.height) return cb(new Error('height is higher than tip'));
  if (height < 0) return cb(new Error('height must be >= 0'));

  var down = height > this.tip.height / 2;

  var traverse = function traverse(err, block) {
    if (err) return cb(err);
    if (block.height === height) return cb(null, block);
    // TODO: remove traversal using block.next by indexing by height every so
    // often and traversing down using header.prevHash
    _this7.getBlock(down ? block.header.prevHash : block.next, traverse);
  };
  this.getBlock(down ? this.tip.hash : this.genesis.hash, traverse);
};

Blockchain.prototype.getLocator = function (from, cb) {
  var _this8 = this;

  if (typeof from === 'function') {
    cb = from;
    from = this.tip.hash;
  }
  var locator = [];
  var getBlock = function getBlock(from) {
    _this8.getBlock(from, function (err, block) {
      if (err && err.notFound) return cb(null, locator);
      if (err) return cb(err);
      locator.push(block.header.getHash());
      if (locator.length < 6 || !block.height === 0) {
        return getBlock(block.header.prevHash);
      }
      cb(null, locator);
    });
  };
  getBlock(from);
};

Blockchain.prototype._error = function (err) {
  this.emit('error', err);
};

Blockchain.prototype._put = function (hash, opts, cb) {
  var _this9 = this;

  if (!this.initialized) {
    this.once('ready', function () {
      return _this9._put(hash, opts, cb);
    });
    return;
  }
  this.store.put(hash, opts, cb);
};

Blockchain.prototype.createWriteStream = function () {
  var _this10 = this;

  return to({ highWaterMark: 4 }, function (headers, enc, cb) {
    _this10.addHeaders(headers, cb);
  });
};

Blockchain.prototype.createReadStream = function (opts) {
  return new HeaderStream(this, opts);
};

Blockchain.prototype.createLocatorStream = function (opts) {
  var _this11 = this;

  var changed = true;
  var getting = false;
  var pushLocator = function pushLocator(cb) {
    changed = false;
    _this11.getLocator(function (err, locator) {
      if (err) return cb(err);
      getting = false;
      cb(null, locator);
    });
  };
  this.on('consumed', function () {
    changed = true;
  });
  return from(function (size, next) {
    if (getting) return;
    getting = true;
    if (changed) return pushLocator(next);
    _this11.once('consumed', function () {
      return pushLocator(next);
    });
  });
};

Blockchain.prototype.addHeaders = function (headers, cb) {
  var _this12 = this;

  if (this.adding) return cb(new Error('Already adding headers'));

  var previousTip = this.tip;
  this.adding = true;
  var done = function done(err, last) {
    _this12.emit('consumed');
    if (err) _this12.emit('headerError', err);else _this12.emit('headers', headers);
    _this12.adding = false;
    cb(err, last);
  };

  // TODO: store all orphan tips
  this.getBlock(headers[0].prevHash, function (err, start) {
    if (err && err.name === 'NotFoundError') return done(new Error('Block does not connect to chain'));
    if (err) return done(err);
    start.hash = start.header.getHash();

    async.reduce(headers, start, _this12._addHeader.bind(_this12), function (err, last) {
      if (err) return done(err, last);

      // TODO: add even if it doesn't pass the current tip
      // (makes us store orphan forks, and lets us handle reorgs > 2000 blocks)
      if (last.height > previousTip.height) {
        _this12.getPath(previousTip, last, function (err, path) {
          if (err) return done(err, last);
          if (path.remove.length > 0) {
            var first = { height: start.height + 1, header: headers[0] };
            _this12.store.put(first, { best: true, prev: start }, function (err) {
              if (err) return done(err);
              _this12.emit('reorg', { path: path, tip: last });
              done(null, last);
            });
            return;
          }
          done(null, last);
        });
        return;
      }

      done(null, last);
    });
  });
};

Blockchain.prototype._addHeader = function (prev, header, cb) {
  var _this13 = this;

  if (typeof header === 'function') {
    cb = header;
    header = null;
  }
  if (header == null) {
    header = prev;
    prev = this.tip;
  }

  var height = prev.height + 1;
  var block = {
    height: height,
    hash: header.getHash(),
    header: header
  };

  var put = function put() {
    var tip = height > _this13.tip.height;
    _this13._put({ header: header, height: height }, { tip: tip, prev: prev }, function (err) {
      if (err) return cb(err);
      _this13.emit('block', block);
      _this13.emit('block:' + block.hash.toString('base64'), block);
      if (tip) {
        _this13.tip = block;
        _this13.emit('tip', block);
      }
      cb(null, block);
    });
  };

  if (header.prevHash.compare(prev.hash) !== 0) {
    return cb(new Error('Block does not connect to previous'), block);
  }
  this.params.shouldRetarget(block, function (err, retarget) {
    if (err) return cb(err);
    if (!retarget && header.bits !== prev.header.bits) {
      // TODO: validate
      // console.log("Unexpected difficulty change at height" + height);
      // return cb(new Error('Unexpected difficulty change at height ' + height), block)
    }
    _this13.validProof(header, function (err, validProof) {
      if (err) return cb(err);
      if (!validProof) {
        return cb(new Error('Mining hash is above target. ' + 'Hash: ' + header.getId() + ', ' + 'Target: ' + u.expandTarget(header.bits).toString('hex') + ')'), block);
      }
      // TODO: other checks (timestamp, version)
      if (retarget) {
        return _this13.params.calculateTarget(block, _this13, function (err, target) {
          if (err) return cb(err, block);

          var expected = u.compressTarget(target);
          if (expected !== header.bits) {
            // TODO: validate
            // console.log("Bits in block (" + header.bits.toString(16) + ") different than expected (" + expected.toString(16) + ")");
            // return cb(new Error('Bits in block (' + header.bits.toString(16) + ')' + ' different than expected (' + expected.toString(16) + ')'), block);
          }
          put();
        });
      }
      put();
    });
  });
};

Blockchain.prototype.validProof = function (header, cb) {
  this.params.miningHash(header, function (err, hash) {
    if (err) return cb(err);
    var target = u.expandTarget(header.bits);
    cb(null, hash.compare(target) !== 1);
  });
};

Blockchain.prototype.maxTarget = function () {
  return u.expandTarget(this.params.genesisHeader.bits);
};
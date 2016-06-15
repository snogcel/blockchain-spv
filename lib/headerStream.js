'use strict';

var Readable = require('stream').Readable;
var inherits = require('inherits');
var u = require('bitcoin-util');
require('setimmediate');

function HeaderStream(chain, opts) {
  if (!chain) throw new Error('"chain" argument is required');
  if (!(this instanceof HeaderStream)) return new HeaderStream(chain, opts);
  Readable.call(this, { objectMode: true });

  opts = opts || {};
  this.chain = chain;
  this.start = this.cursor = opts.from || chain.genesis.hash;
  this.stopHash = opts.stopHash;
  this.stopHeight = opts.stopHeight;

  this.paused = false;
  this.ended = false;
  this.first = true;
  if (!opts.from || opts.from.equals(u.nullHash)) {
    this.first = false;
  }
  this.lastHash = u.nullHash;
  this.lastBlock = null;
}
inherits(HeaderStream, Readable);

HeaderStream.prototype._read = function () {
  this._next();
};

HeaderStream.prototype._next = function () {
  var _this = this;

  if (this.paused || this.ended) return;
  this.paused = true;

  // we reached end of chain, wait for new tip
  if (!this.cursor) {
    this.chain.once('tip', function (block) {
      _this.chain.getPath(_this.lastBlock, block, function (err, path) {
        if (err) return _this.emit('error', err);
        // reorg handling (remove blocks to get to new fork)
        var _iteratorNormalCompletion = true;
        var _didIteratorError = false;
        var _iteratorError = undefined;

        try {
          for (var _iterator = path.remove[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
            var _block = _step.value;

            _block.add = false;
            _this._push(_block);
          }
        } catch (err) {
          _didIteratorError = true;
          _iteratorError = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion && _iterator.return) {
              _iterator.return();
            }
          } finally {
            if (_didIteratorError) {
              throw _iteratorError;
            }
          }
        }

        var _iteratorNormalCompletion2 = true;
        var _didIteratorError2 = false;
        var _iteratorError2 = undefined;

        try {
          for (var _iterator2 = path.add[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
            var _block2 = _step2.value;

            _block2.add = true;
            _this._push(_block2);
          }
        } catch (err) {
          _didIteratorError2 = true;
          _iteratorError2 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion2 && _iterator2.return) {
              _iterator2.return();
            }
          } finally {
            if (_didIteratorError2) {
              throw _iteratorError2;
            }
          }
        }

        _this.paused = false;
        setImmediate(_this._next.bind(_this));
      });
    });
    return;
  }

  // stream headers that are already stored
  this.chain.getBlock(this.cursor, function (err, block) {
    if (_this.ended) return;
    if (err) return _this.emit('error', err);
    if (!block) {
      // if current "next" block is not found
      if (_this.cursor.equals(_this.start)) {
        // if this is the `from` block, wait until we see the block
        _this.chain.once('header:' + _this.cursor.toString('base64'), _this._next.bind(_this));
      } else {
        _this.emit('error', new Error('HeaderStream error: chain should ' + ('continue to block "' + _this.cursor.toString('hex') + '", but it was ') + 'not found in the BlockStore'));
      }
      return;
    }

    _this.paused = false;
    block.add = true;
    var res = _this._push(block);
    if (_this.stopHash && _this.stopHash.equals(_this.lastHash) || _this.stopHeight && _this.stopHeight === block.height) {
      return _this.push(null);
    }
    if (res) _this._next();
  });
};

HeaderStream.prototype._push = function (block) {
  this.cursor = block.next;
  this.lastHash = block.header.getHash();
  this.lastBlock = block;
  if (this.first) {
    this.first = false;
    return true;
  }
  return this.push(block);
};

HeaderStream.prototype.end = function () {
  this.ended = true;
  this.push(null);
};

module.exports = HeaderStream;
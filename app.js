/*jshint node: true, asi: true */
'use strict'

var config = require('./lib/config'),
    logger = require('./lib/logger'),
    //bittrex = require('node-bittrex-api'),    // See comment at the top of lib/node_bittrex_api-0.7.8-PATCHED.js
    bittrex = require('./lib/node_bittrex_api-0.7.8-PATCHED'),
    _ = require('lodash'),
    program = require('commander'),
    util = require('util'),
    moment = require('moment'),
    jsonfile = require('jsonfile'),
    async = require('async'),
    prompt = require('prompt')

// Command line args for special recovery mode functions; not needed in normal operation
program
    .option('--purge-open-orders', 'Cancel ALL open limit orders, and exit (CAUTION)')
    .option('--restore-orders <file>', 'Restore limit orders from the specified backup file, and exit')
    .option('--double-orders', 'Set a number of double orders')
    .parse(process.argv)

bittrex.options({
    'apikey': config.credentials.key,
    'apisecret': config.credentials.secret,
    'stream': false,
    'verbose': false,
    'cleartext': false,
    'inverse_callback_arguments': true
})

// Cancel an order, and wait for it to finish cancelling
var doCancelOrder = function(uuid, cb) {
    bittrex.cancel({uuid: uuid}, function(err, data) {
        if (err || !data.success) {
            logger.warn('Failed to cancel order %s: %s; %j; skipping...', uuid, data ? data.message : '', err)
            cb(false)  // continue with next
            return
        }

        /* Wait a short period before replacing the order to give it time to cancel, then verify that it has
         * finished cancelling before placing the new order. */
        var getOrder = function() {
            bittrex.getorder({uuid: uuid}, getOrderCb)
        }
        var getOrderCb = function(err, data) {
            if (err || !data.success || !data.result) {
                logger.warn('Checking order %s failed: %s; %j; will retry...', uuid, data ? data.message : '', err)
                setTimeout(getOrder, config.retryPeriodMs)
                return
            }
            if (data.result.IsOpen) {
                logger.debug('Cancellation still pending for order %s; will retry...', uuid)
                setTimeout(getOrder, config.retryPeriodMs)
                return
            }

            cb(true)
        }
        setTimeout(getOrder, config.retryPeriodMs)
    })
}

// Create a new limit order
var doCreateOrder = function(newOrderType, newOrder, cb) {
    var createOrder = function() {
        if (newOrderType === 'LIMIT_BUY')
            bittrex.buylimit(newOrder, createOrderCb)
        else if (newOrderType === 'LIMIT_SELL')
            bittrex.selllimit(newOrder, createOrderCb)
        else
            throw new Error('Unhandled order type: ' + newOrderType)
    }
    var createOrderCb = function(err, data) {
        if (err || !data.success) {
            logger.warn('Failed to create replacement %s order, %j: %s; %j; will retry...', newOrderType, newOrder, data ? data.message : '', err)
            setTimeout(createOrder, config.retryPeriodMs)
            return
        }

        cb(data.result.uuid)
    }
    setTimeout(createOrder, 0)
}


// https://github.com/flatiron/prompt
if (program.doubleOrders) {
    var schema = {
        properties: {
            base: {
                type: 'string',
                message: 'Must be a string',
                required: true,
                description: 'Base market symbol',
                default: 'BTC'
            },
            market: {
                type: 'string',
                message: 'Must be a string',
                required: true,
                description: 'Symbol pair'
            },
            buyPrice: {
                type: 'number',
                message: 'Price must be a number',
                required: true,
                description: 'Buy price (rate)'
            },
            buyQuantity: {
                type: 'number',
                required: true,
                description: 'Quantity (units)'
            },
            orderCount: {
                type: 'number',
                message: 'Amount must be a number',
                required: true,
                description: 'Amount of double orders to create',
                default: 2
            }
        }
    };

    prompt.start();
    prompt.get(schema, function (err, result) {
        console.log(
            'Creating ' + result.orderCount +
            ' double orders with start price: ' + result.buyPrice +
            ' and amount: ' + result.buyQuantity
        );

        var confirmSchema = {
            properties: {
                ok: {
                    type: 'string',
                    required: true,
                    description: 'Proceed',
                    default: 'Y/N'
                }
            }
        }

        prompt.get(confirmSchema, function (err, res) {
            if (String(res.ok).toUpperCase() !== 'Y') {
                return;
            }
            var orderType = 'LIMIT_SELL',
                market = result.base.toUpperCase() + '-' + result.market.toUpperCase(),
                remainingQuantity = result.buyQuantity,
                price = result.buyPrice,
                targetBuffer = 0.00000010,
                range = _.range(result.orderCount)

            async.mapLimit(range, 2, function (o, cb, x) {
                console.log(o);

                remainingQuantity = remainingQuantity / 2
                price = price * 2

                var order = {
                    market: market,
                    quantity: remainingQuantity, // amount of coin to buy / sell
                    rate: price, // price to place order at

                    IsConditional: true,
                    Condition: 'GREATER_THAN',
                    ConditionTarget: (price - targetBuffer).toFixed(8)
                }

                console.log(order);

                // {
                    // "Exchange": "BTC-CPC",
                    // "OrderType": "LIMIT_SELL",
                    // "Quantity": 12.21428572,
                    // "QuantityRemaining": 12.21428572,
                    // "Limit": 0.00012248,
                    // "CommissionPaid": 0,
                    // "Price": 0,
                    // "PricePerUnit": null,
                    // "Opened": "2017-11-01T04:28:26.973",
                    // "Closed": null,
                    // "CancelInitiated": false,
                    // "ImmediateOrCancel": false,
                    // "IsConditional": true,
                    // "Condition": "GREATER_THAN",
                    // "ConditionTarget": 0.0001224
                // },

                doCreateOrder(orderType, order, function(newUuid) {
                    logger.debug('Order %s created.', newUuid)
                    cb()
                })
            })
        })

    });
    return;
}

bittrex.getopenorders({}, function(err, data) {
    if (err || !data.success) {
        logger.error('Failed to get open orders: %s; %j', data ? data.message : '', err)
        return  // fatal
    }

    var now = new Date()
    var orders = data.result
    var limitOrders = _.filter(orders, o => {
        return (o.OrderType === 'LIMIT_BUY' || o.OrderType === 'LIMIT_SELL')
    })
    logger.info('You have %d open orders, of which %d are limit orders.',
        orders.length, limitOrders.length)

    // *** Recovery functions - not part of normal operation; see the README
    if (program.purgeOpenOrders) {
        logger.warn('Cancelling %d open limit orders...', limitOrders.length)
        async.mapLimit(limitOrders, config.concurrentTasks, function (o, cb) {
            var uuid = o.OrderUuid
            doCancelOrder(uuid, function() {
                logger.debug('Order %s cancelled.', uuid)
                cb()
            })
        })
        return  // exit
    } else if (program.restoreOrders) {
        var restoreOrders = jsonfile.readFileSync(program.restoreOrders)
        logger.warn('Restoring %d limit orders from backup...', restoreOrders.length)
        async.mapLimit(restoreOrders, config.concurrentTasks, function (o, cb) {
            var newOrderType = o.OrderType
            var newOrder = {
                market: o.Exchange,
                quantity: o.QuantityRemaining,
                rate: o.Limit
            }

            logger.debug('Creating %s order: %j', newOrderType, newOrder)
            doCreateOrder(newOrderType, newOrder, function(newUuid) {
                logger.debug('Order %s created.', newUuid)
                cb()
            })
        })
        return  // exit
    }

    // *** Normal operation - backup current open limit orders, then refresh "stale" orders

    var backupFile = util.format(
        config.backupFile,
        moment().utc().format('YYYYMMDDHHmmss') + 'Z' // literal Zulu TZ flag, since it's UTC
    )
    jsonfile.writeFileSync(backupFile, limitOrders, { spaces: 2 })
    logger.info('All current limit orders backed up to file: %s', backupFile)

    var staleOrders;
    if (config.replaceAllOrders) {
        staleOrders = orders
        logger.info('Replacing all limit orders (replaceAllOrders == true)...')
    } else {
        staleOrders = _.filter(limitOrders, o => {
            var orderTs = Date.parse(o.Opened)
            var deltaMs = now - orderTs
            var deltaDays = (((deltaMs / 1000) / 60) / 60 ) / 24
            return deltaDays > config.maxOrderAgeDays
        })
        logger.info('%d limit orders older than %d days will be replaced...',
            staleOrders.length, config.maxOrderAgeDays)
    }

    var staleOrderCount = staleOrders.length
    if (staleOrderCount <= 0) {
        logger.info('Nothing to do.')
        return
    }

    async.mapLimit(staleOrders, config.concurrentTasks, function (o, cb) {
        var uuid = o.OrderUuid
        var newOrderType = o.OrderType
        var newOrder = {
            market: o.Exchange,
            quantity: o.QuantityRemaining,
            rate: o.Limit
        }

        logger.debug('Replacing order %s with new %s order: %j', uuid, newOrderType, newOrder)
        doCancelOrder(uuid, function(ok) {
            if (ok) {
                // Order has been cancelled; create the replacement order
                doCreateOrder(newOrderType, newOrder, function(newUuid) {
                    logger.debug('Order %s replaced by new order %s.', uuid, newUuid)
                    cb()
                })
            } // else, skip it this run
        })
    })

})


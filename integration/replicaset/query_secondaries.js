
var testCase = require('nodeunit').testCase,
  debug = require('sys').debug
  inspect = require('sys').inspect,
  ReplicaSetManager = require('../tools/replica_set_manager').ReplicaSetManager,
  Db = require('../../lib/mongodb').Db,
  ReplSetServers = require('../../lib/mongodb').ReplSetServers,
  Server = require('../../lib/mongodb').Server,
  Step = require("step");  

// Keep instance of ReplicaSetManager
var serversUp = false;
var RS = null;

// var ensureConnection = function(test, numberOfTries, callback) {
//   // Replica configuration
//   var replSet = new ReplSetServers( [ 
//       new Server( RS.host, RS.ports[1], { auto_reconnect: true } ),
//       new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
//       new Server( RS.host, RS.ports[2], { auto_reconnect: true } )
//     ], 
//     {rs_name:RS.name}
//   );
//   
//   if(numberOfTries <= 0) return callback(new Error("could not connect correctly"), null);
// 
//   var db = new Db('integration_test_', replSet);
//   db.open(function(err, p_db) {
//     if(err != null) {
//       db.close();
//       // Wait for a sec and retry
//       setTimeout(function() {
//         numberOfTries = numberOfTries - 1;
//         ensureConnection(test, numberOfTries, callback);
//       }, 1000);
//     } else {
//       return callback(null, p_db);
//     }    
//   })            
// }

module.exports = testCase({
  setUp: function(callback) {
    // Create instance of replicaset manager but only for the first call
    if(!serversUp) {
      serversUp = true;
      RS = new ReplicaSetManager();
      RS.startSet(function(err, result) {      
        if(err != null) throw err;
        // Finish setup
        callback();      
      });      
    } else {
      RS.restartKilledNodes(function(err, result) {
        if(err != null) throw err;
        callback();        
      })
    }
  },
  
  tearDown: function(callback) {
    RS.restartKilledNodes(function(err, result) {
      if(err != null) throw err;
      callback();        
    })
  },

  shouldReadPrimary : function(test) {
    // Replica configuration
    var replSet = new ReplSetServers( [ 
        new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      ], 
      {rs_name:RS.name, read_secondary:true}
    );

    // Insert some data
    var db = new Db('integration_test_', replSet);
    db.open(function(err, p_db) {
      // Drop collection on replicaset
      p_db.dropCollection('testsets', function(err, r) {
        test.equal(false, p_db.serverConfig.isReadPrimary());
        test.equal(false, p_db.serverConfig.isPrimary());
        test.done();
      });
    })                
  },
  
  shouldCorrectlyTestConnection : function(test) {
    // Replica configuration
    var replSet = new ReplSetServers( [ 
        new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      ], 
      {rs_name:RS.name, read_secondary:true}
    );

    // Insert some data
    var db = new Db('integration_test_', replSet);
    db.open(function(err, p_db) {
      // Drop collection on replicaset
      p_db.dropCollection('testsets', function(err, r) {
        test.ok(p_db.serverConfig.primary != null);
        test.ok(p_db.serverConfig.read != null);
        test.ok(p_db.serverConfig.primary.port != p_db.serverConfig.read.port);
        test.done();
      });
    })
  },
  
  shouldCorrectlyQuerySecondaries : function(test) {
    // Replica configuration
    var replSet = new ReplSetServers( [ 
        new Server( RS.host, RS.ports[0], { auto_reconnect: true } ),
      ], 
      {rs_name:RS.name, read_secondary:true}
    );

    // Insert some data
    var db = new Db('integration_test_', replSet);
    db.open(function(err, p_db) {
      p_db.collection("testsets", {safe:{w:3, wtimeout:10000}}, function(err, collection) {
        Step(
          function inserts() {
            var group = this.group();
            collection.save({a:20}, group());
            collection.save({a:30}, group());
            collection.save({a:40}, group());
          },
          
          function done(err, values) {
            var results = [];
            
            collection.find().each(function(err, item) {
              if(item == null) {
                // Check all the values
                var r = [20, 30, 40];
                for(var i = 0; i < r.length; i++) {
                  test.equal(1, results.filter(function(element) {
                    return element.a == r[i];
                  }).length);
                }
                
                // p_db.close();
                test.done();
              } else {
                results.push(item);
              }
            });            
          }
        );
      });      
    })    
  }
})


















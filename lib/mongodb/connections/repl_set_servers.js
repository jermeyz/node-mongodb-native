var Connection = require('../connection').Connection,
  DbCommand = require('../commands/db_command').DbCommand,
  MongoReply = require('../responses/mongo_reply').MongoReply,
  debug = require('util').debug,
  inspect = require('util').inspect,
  Server = require('./server').Server;

/**
* ReplSetServers constructor provides master-slave functionality
*
* @param serverArr{Array of type Server}
* @return constructor of ServerCluster
*
*/
var ReplSetServers = exports.ReplSetServers = function(servers, options) {
  // Contains the master server entry
  this.master = null;
  this.target = null;
  this.options = options == null ? {} : options;
  
  // Set up internal state variables
  this.replicaSet = options["rs_name"];
  // Keep references to node types for caching purposes
  this.secondaries = [];
  this.arbiters = [];
  // Are we allowing reads from secondaries ?
  this.readSecondary = options["read_secondary"] == null ? false : options["read_secondary"];
  this.slaveOk = false;   

  if(servers.constructor != Array || servers.length == 0) {
    throw Error("The parameter must be an array of servers and contain at least one server");
  } else if(servers.constructor == Array || servers.length > 0) {
    var count = 0;
    servers.forEach(function(server) {
      if(server instanceof Server) count = count + 1;
    });

    if(count < servers.length) {
      throw Error("All server entries must be of type Server");
    } else {
      this.servers = servers;
    }
  }
  
  // Auto Reconnect property
  Object.defineProperty(this, "autoReconnect", {
      enumerable: true
    , get: function () {
        if(this.target != null) return this.target.autoReconnect;
        if(this.primary != null) return this.primary.autoReconnect;
      }
  });

  // Auto Reconnect property
  Object.defineProperty(this, "host", {
      enumerable: true
    , get: function () {
        return this.primary.host;
      }
  });

  Object.defineProperty(this, "port", {
      enumerable: true
    , get: function () {
        return this.primary.port;
      }
  });

  Object.defineProperty(this, "read", {
      enumerable: true
    , get: function () {
        return this.secondaries.length > 0 ? this.secondaries[0] : null;
      }
  });

  // Master connection property
  Object.defineProperty(this, "primary", {
      enumerable: true
    , get: function () {
        // Allow overriding to a specific connection
        if(this.target != null && this.target instanceof Server) {
          return this.target.primary;
        } else {
          var finalServer = null;
          this.servers.forEach(function(server) {
            if(server.master == true && ( server.connection.connection.readyState == "open") ) finalServer = server;
          });
          return finalServer != null ? finalServer.primary : finalServer;
        }
      }
  });
};

ReplSetServers.prototype.setTarget = function(target) {
  this.target = target;
};

ReplSetServers.prototype.isConnected = function() {
  return this.primary != null && this.primary.isConnected();
}

// ReplSetServers.prototype.isReadPrimary = function() {
//   debug("====================================================================")
//   debug(inspect(this.primary))
//   
//   return this.primary != null ? true : false;
// }

ReplSetServers.prototype.isPrimary = function(config) {
  // return this.primary != null ? true : false;
  return this.readSecondary && this.secondaries.length > 0 ? false : true;
  // return config != null && (config['ismaster'] == 1 || config['ismaster'] == true);
}

ReplSetServers.prototype.isReadPrimary = ReplSetServers.prototype.isPrimary;

ReplSetServers.prototype.connect = function(parent, callback) {
  var replSetSelf = this;
  var serverConnections = this.servers;
  var numberOfConnectedServers = 0; 
  var numberOfErrorServers = 0;
  this.addresses = {};

  var initServer = function(server)  {
    // debug("===================================== init server")
    replSetSelf.addresses[server.host + ':' + server.port] = 1;
    server.connection = new Connection(server.host, server.port, server.autoReconnect);

    // Add the connect
    server.connection.on("connect", function() {
      // Create a callback function for a given connection
      var connectCallback = function(err, reply) {
        // Update number of connected servers, ensure we update before any possible errors
        numberOfConnectedServers = numberOfConnectedServers + 1;

        // debug("---------------------------------------------------")
        // debug("numberOfConnectedServers = " + numberOfConnectedServers)
        // debug("serverConnections.length = " + serverConnections.length)
        // debug("numberOfErrorServers = " + numberOfErrorServers) 
        // if(err != null) {
        //   debug("err = " + inspect(err))
        // }
                
        if(err != null) return callback(err, null);
        // debug("============================================= server config")
        // debug(inspect(reply.documents[0]));        
        
        server.master = reply.documents[0].ismaster == 1 ? true : false;
        server.connected = true;
            
        if(reply.documents[0].hosts != undefined) {
          // Get all possible server references from the node
          var node = reply.documents[0];
          // debug("  ===================================== node");
          // debug("  " + inspect(node));          
          var hosts = node.hosts;
          var arbiters = node.arbiters != null ? node.arbiters : [];
          var passives = node.passives != null ? node.passives : [];
          var replicas = hosts.concat(arbiters).concat(passives);
        
          // Add server to list of connected servers
          if(replSetSelf.addresses[server.host + ":" + server.port] == null) {
            // Add server to addresses, ensure we don't have duplicate entries
            replSetSelf.addresses[server.host + ":" + server.port] = 1;
            // Add to server connections
            serverConnections.push( server );
            // Adjust the number of connections opened
            numberOfConnectedServers = numberOfConnectedServers + 1;              
          }
        
          // Check if the node is a secondary one
          if(node["secondary"]) {
            // If the reference does not exist
            if(replSetSelf.secondaries.indexOf(server) == -1) {
              replSetSelf.secondaries.push(server);
            }              
          } else if(node["arbiterOnly"]) {
            if(replSetSelf.arbiters.indexOf(server) == -1) {
              replSetSelf.arbiters.push(server);
            }                            
          } else if(node["ismaster"]) {
            if(replSetSelf.replicaSet != node["setName"]) {
              // Close all servers and return an error
              serverConnections.forEach(function(s) {
                s.close();
              });
              // Signal error
              return callback("configured mongodb replicaset does not match provided replicaset [" + node["setName"] + "] != [" + replSetSelf.replicaSet + "]");
            }
          }
        
          // Add servers to list of connections, discover servers in the replicaset
          // that the driver has not explicitly added
          for(var i in replicas) {
            var replica = replicas[i];                          

            // debug("============================================= replica")
            // debug("== " + replSetSelf.addresses[replica])
            // debug(inspect(replica))
            // Make sure we don't have duplicate entries
            if(replSetSelf.addresses[replica] == 1) {
              continue;
            }
            // if(replica in replSetSelf.addresses) {                  
            //   continue;
            // } 
          
            // debug("============================================= replica connect")
            // debug(inspect(replica))
          
            // Add replica address to our internal address array
            replSetSelf.addresses[replica] = 1;
            var ipAndPort = replica.split(":");
            var newServer = new Server(ipAndPort[0], parseInt( ipAndPort[1]), { auto_reconnect: true});
          
            // Add to connection list
            serverConnections.push(newServer);
            initServer(newServer);
          }
        }

        // emit a message saying we got a master and are ready to go and change state to reflect it
        if(numberOfConnectedServers == serverConnections.length && (parent.state == 'notConnected')) {
          // debug("===============================   numberOfConnectedServers == serverConnections.length && (parent.state == 'notConnected')")
          parent.isInitializing  = false;
          // If we have no master connection
          if(replSetSelf.primary == null && !replSetSelf.readSecondary && replSetSelf.secondaries.length > 0) {
            return callback(new Error('No master available'), null);
          }
          
          parent.state = 'connected';
          return callback(null, parent);
        } 

        //we have the master we are ok, wait for others (if any) to connect too
        if(server.master) {
          // debug("=========================================== master")          
          parent.state = 'connected';
          replSetSelf.target = server;
        }            

        // We had some errored out servers, does not matter as long as we have a master server
        // we can write to.
        if ((numberOfConnectedServers + numberOfErrorServers) == serverConnections.length) { 
          // debug("===============================   (numberOfConnectedServers + numberOfErrorServers) == serverConnections.length")
          // debug("parent.state = " + parent.state)
          parent.isInitializing  = false;
          // If we have no master connection
          if(replSetSelf.primary == null && !replSetSelf.readSecondary && replSetSelf.secondaries.length > 0) {
            return callback(new Error('No master available'), null);
          }

          if (parent.state == 'connected') {
            return callback( null, parent );
          } else { 
            return callback(new Error('No master available'), null);
          }
        }
      };

      // Create db command and Add the callback to the list of callbacks by the request id (mapping outgoing messages to correct callbacks)
      var db_command = DbCommand.createIsMasterCommand(parent);        
      parent.on(db_command.getRequestId().toString(), connectCallback);
      parent.notReplied[db_command.getRequestId().toString()] = this;  

      // Let's send a request to identify the state of the server
      this.send(db_command);
      
      server.connection.on("data", function(message) {
        // Parse the data as a reply object
        var reply = new MongoReply(parent, message);
        // Emit error if there is one       
        reply.responseHasError ? parent.emit(reply.responseTo.toString(), reply.documents[0], reply) : parent.emit(reply.responseTo.toString(), null, reply);
        // Remove the listener
        if(parent.notReplied [reply.responseTo.toString()]) {
         delete parent.notReplied[reply.responseTo.toString()];
         parent.removeListener(reply.responseTo.toString(), parent.listeners(reply.responseTo.toString())[0]);
        }
      });
    });

    server.connection.on("error", function(err) {
      // debug("====================== error for server");

      if(parent.isInitializing) {
        //we only have one error, if the rest are ok there is no problem
        numberOfErrorServers++;
        //console.log( server.host + ':' + server.port + ' down!!!'+ err );
        if((numberOfErrorServers + numberOfConnectedServers) == serverConnections.length) {
          parent.isInitializing  = false;
          
          if(parent.state == 'connected') {
            return callback( null, parent);
          } else { 
            return callback(new Error('No master available'), null);
          }
        }
      } else {
        for(var i in parent.notReplied) {
          if(parent.notReplied[i] == this) {
            delete parent.notReplied[i];
            parent.emit(i, null, { documents: [{'$err':'Connection closed'}] });
            parent.removeListener( i, parent.listeners( i )[0]);
          }
        }
      }
    });      

    // Emit timeout and close events so the client using db can figure do proper error handling (emit contains the connection that triggered the event)
    server.connection.on("timeout", function() { 
      // debug("====================== timeout for server");
      parent.emit("timeout", replSetSelf); });
    server.connection.on("close", function() { 
      // debug("====================== close for server");
      parent.emit("close", replSetSelf); });
    
    //attempting connect to
    // debug("connecting to server at :: " + (server.host + ':' + server.port));
    // Open the connection
    server.connection.open();
  };

  // Initialize connections
  serverConnections.forEach(initServer);
}

ReplSetServers.prototype.checkoutWriter = function() {
  return this.primary.connection;
}

ReplSetServers.prototype.checkoutReader = function() {
  return this.primary.connection;
}

ReplSetServers.prototype.close = function() {
  this.servers.forEach(function(server) {
    server.close();
  })  
}

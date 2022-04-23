'use strict';

const _ = require('lodash');
const bodyParser = require('body-parser');
const express = require('express');
const mongodb = require('mongodb');
const colors = require('colors/safe');
const ConfigParser = require('configparser');
const config = new ConfigParser();
const app = express();
const ObjectID = mongodb.ObjectID;
const MongoClient = mongodb.MongoClient;

const settings_file = '../settings.conf';
config.read(settings_file);
const CONFIG_FILE_PATH = config.get('DEFAULTS', 'CONFIG_FILENAME');
const PORT_NUM = config.get('DEFAULTS', 'MONGODB_PORT');

const CONFIG_FILE = '/home/'.concat(process.env['USER'], '/', CONFIG_FILE_PATH);

config.read(CONFIG_FILE);
const user = config.get('User1', 'user');
const pswd = config.get('User1', 'pswd');

// const mongoCreds = require('./auth.json');
const mongoURL = `mongodb://${user}:${pswd}@localhost:${PORT_NUM}/`;

var argv = require('minimist')(process.argv.slice(2));

const port = argv.port || 8012;

function makeMessage(text) {
  return `${colors.blue('[store]')} ${text}`;
}

function log(text) {
  console.log(makeMessage(text));
}

function failure(response, text) {
  const message = makeMessage(text);
  console.error(message);
  return response.status(500).send(message);
}

function success(response, text) {
  const message = makeMessage(text);
  console.log(message);
  return response.send(message);
}

function mongoConnectWithRetry(delayInMilliseconds, callback) {
  MongoClient.connect(mongoURL, (err, connection) => {
    if (err) {
      console.error(`Error connecting to MongoDB: ${err}`);
      setTimeout(() => mongoConnectWithRetry(delayInMilliseconds, callback), delayInMilliseconds);
    } else {
      log('connected succesfully to mongodb');
      callback(connection);
    }
  });
}

function markAnnotation(collection, gameid, sketchid) {
  collection.update({ _id: ObjectID(sketchid) }, {
    $push: { games: gameid },
    $inc: { numGames: 1 }
  }, function (err, items) {
    if (err) {
      console.log(`error marking annotation data: ${err}`);
    } else {
      console.log(`successfully marked annotation. result: ${JSON.stringify(items).substring(0,200)}`);
    }
  });
};


function serve() {
  mongoConnectWithRetry(2000, (connection) => {

    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    app.post('/db/insert', (request, response) => {
      if (!request.body) {
        return failure(response, '/db/insert needs post request body');
      }
      console.log(`got request to insert into ${request.body.dbname}, ${request.body.colname}`);

      var databaseName = request.body.dbname;
      var collectionName = request.body.colname;
      if (!collectionName) {
        return failure(response, '/db/insert needs collection');
      }
      if (!databaseName) {
        return failure(response, '/db/insert needs database');
      }
      if (!databaseName.includes('_resp')) {
        console.log(`${databaseName}/${collectionName} is not a response database, appending _resp`);
        databaseName = databaseName.concat('_resp');
      }

      const database = connection.db(databaseName);

      // Add collection if it doesn't already exist
      if (!database.collection(collectionName)) {
        console.log('creating collection ' + collectionName);
        database.createCollection(collectionName);
      }

      const collection = database.collection(collectionName);

      const data = _.omit(request.body, ['colname', 'dbname']);
      collection.insert(data, (err, result) => {
        if (err) {
          return failure(response, `error inserting data: ${err}`);
        } else {
          return success(response, `successfully inserted data. result: ${JSON.stringify(result).substring(0,200)}`);
        }
      });
    });

    app.post('/db/getstims', (request, response) => {
      if (!request.body) {
        return failure(response, '/db/getstims needs post request body');
      }
      console.log(`got request to get stims from ${request.body.dbname}/${request.body.colname}`);

      const databaseName = request.body.dbname;
      const collectionName = request.body.colname;
      const iterName = request.body.iterName;
      if (!collectionName) {
        return failure(response, '/db/getstims needs collection');
      }
      if (!databaseName) {
        return failure(response, '/db/getstims needs database');
      }

      const database = connection.db(databaseName);
      const collection = database.collection(collectionName);

      // sort by number of times previously served up and take the first
      collection.aggregate([
        { $match: { iterName: iterName } }, // only serve the iteration we want
        { $sort: { numGames: 1 } },
        { $limit: 1 }
      ]).toArray((err, results) => {
        if (err) {
          console.log(err);
        } else {
          // Immediately mark as annotated so others won't get it too
          try {
            markAnnotation(collection, request.body.gameid, results[0]['_id']);
          }
          catch (err) {
            console.log("Couldn't mark gameID as served", err);
          }
          console.log("Sending", results[0]);
          response.send(results[0]);
        }
      });
    });

    app.post('/db/exists', (request, response) => {
      if (!request.body) {
        return failure(response, '/db/exists needs post request body');
      }
      const databaseName = request.body.dbname;
      const collectionName = request.body.colname;
      const database = connection.db(databaseName);
      const query = request.body.query;
      const projection = request.body.projection;
      var collectionList = [collectionName];
      function checkCollectionForHits(collectionName, query, projection, callback) {
        const collection = database.collection(collectionName);
        collection.find(query, projection).limit(1).toArray((err, items) => {
          callback(!_.isEmpty(items));
        });
      }
      function checkEach(collectionList, checkCollectionForHits, query,
        projection, evaluateTally) {
        var doneCounter = 0;
        var results = 0;
        collectionList.forEach(function (collectionName) {
          checkCollectionForHits(collectionName, query, projection, function (res) {
            log(`got request to find_one in ${collectionName} with` +
              ` query ${JSON.stringify(query).substring(0,200)} and projection ${JSON.stringify(projection).substring(0,200)}`);
            doneCounter += 1;
            results += res;
            if (doneCounter === collectionList.length) {
              evaluateTally(results);
            }
          });
        });
      }
      function evaluateTally(hits) {
        console.log("hits: ", hits);
        response.json(hits > 0);
      }
      checkEach(collectionList, checkCollectionForHits, query, projection, evaluateTally);
    });


    app.listen(port, () => {
      log(`running at http://localhost:${port}`);
    });

  });

}

serve();

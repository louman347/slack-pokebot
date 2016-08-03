'use strict';

const PokemonGO = require('pokemon-go-node-api');
const request = require('request');
const _ = require('lodash');

const logger = require('./logger');
const metrics = require('./metrics');
const geo = require('./geo');

logger.log('info', 'Initialised');

const a = new PokemonGO.Pokeio();

const location = {
  type: 'name',
  name: process.env.PGO_LOCATION,
};
const geoLocation = process.env.PGO_LOCATION.match(/^(-?\d+\.\d+),(-?\d+\.\d+)$/);
if (geoLocation) {
  location.type = 'coords';
  location.coords = {
    latitude: parseFloat(geoLocation[1]),
    longitude: parseFloat(geoLocation[2]),
    altitude: 0.0,
  };
}

const username = process.env.PGO_USERNAME;
const password = process.env.PGO_PASSWORD;
const provider = process.env.PGO_PROVIDER || 'google';

let start_location;
let location_index = 0;

let knownPokemon = {};
function removeKnownPokemon(pokemon) {
  const nextKnownPokemon = {};
  const unknownPokemon = [];

  _.forEach(pokemon, (poke) => {
    if (!knownPokemon[poke.details.SpawnPointId]) {
      unknownPokemon.push(poke);
    }
    nextKnownPokemon[poke.details.SpawnPointId] = true;
  });

  knownPokemon = nextKnownPokemon;
  return unknownPokemon;
}

function removeUninterestingPokemon(pokemon) {
  const interestingPokemon = [];

  _.forEach(pokemon, (poke) => {
    const newPoke = _.clone(poke);
    newPoke.distance = geo.getDistance(poke.position, start_location);
    newPoke.bearing = geo.cardinalBearing(geo.getBearing(start_location, poke.position));
    const optionalNewP = metrics.shouldReport(newPoke);
    if (optionalNewP) {
      interestingPokemon.push(optionalNewP);
    }
  });

  return interestingPokemon;
}

function formatAsTime(seconds) {
  const mins = Math.floor(seconds / 60);
  let secs = Math.floor(seconds % 60);
  if (secs < 10) secs = `0${secs}`;
  return `${mins}:${secs}`;
}

function postPokemonMessage(p) {
  let pre = '';
  if (p.rarity.match(/rare/i)) {
    pre = '@here ';
  }
  geo.reverseGeoCode(p.position, (geocode) => {

    const seconds = Math.floor(p.details.TimeTillHiddenMs / 1000);
    let remaining = `${formatAsTime(seconds)} remaining`;
    // if seconds does not make sense, ignore it
    if (seconds < 0) remaining = '';

    const message = `${pre} A wild *${p.pokemon.name}* appeared!\n<https://maps.google.com/maps?z=12&t=h&q=loc:${p.position.latitude}+${p.position.longitude}|${p.distance}m ${p.bearing} ${geocode}>\n${remaining}`;

    const COLOUR_BY_RARITY = {
      common: '#19A643',
      uncommon: '#1BC4B9',
      rare: '#1E0BE6',
      'ultra-rare': '#E600FF',
    };

    if (process.env.SLACK_WEBHOOK_URL) {
      request.post({
        url: process.env.SLACK_WEBHOOK_URL,
        json: true,
        body: {
          attachments: [
            {
              fallback: message,
              color: COLOUR_BY_RARITY[p.rarity],
              thumb_url: p.pokemon.img,
              text: message,
              unfurl_media: true,
              mrkdwn_in: ['text'],
            },
          ],
        },
      }, (error, response, body) => {
        if (error) {
          logger.error(error);
        }
        if (response.body) {
          logger.log(response.body);
        }
        if (body) {
          logger.log(body);
        }
      });
    }
    logger.log('info', `POST: ${message}`);
  });
}

function sendMessage(pokemon) {
  _.forEach(pokemon, (poke) => {
    postPokemonMessage(poke);
  });
}

a.init(username, password, location, provider, (err) => {
  if (err) {
    logger.error(err);
    process.exit(2);
  }

  logger.log('info', `Current location: ${a.playerInfo.locationName}`);
  logger.log('info', `lat/long/alt: : ${a.playerInfo.latitude} ${a.playerInfo.longitude} ${a.playerInfo.altitude}`);
  start_location = {
    latitude: a.playerInfo.latitude,
    longitude: a.playerInfo.longitude,
  };
  const original_start_location = _.clone(start_location);

  a.GetProfile((error, profile) => {
    if (error) {
      logger.error(error);
      process.exit(3);
    }

    logger.log('info', `Username: ${profile.username}`);

    function getHeartbeat() {
      logger.log('info', 'Requesting heartbeat');

      var temp_location = {
        type: 'coords',
        coords: {
          latitude: original_start_location.latitude,
          longitude: original_start_location.longitude,
          altitude: 0.0
        }
      };
      switch (location_index) {
        case 1:
          temp_location.coords.latitude = original_start_location.latitude - 0.000315;
          temp_location.coords.longitude = original_start_location.longitude - 0.000315;
          location_index++;
          break;
        case 2:
          temp_location.coords.latitude = original_start_location.latitude - 0.000315;
          temp_location.coords.longitude = original_start_location.longitude + 0.000315;
          location_index++;
          break;
        case 3:
          temp_location.coords.latitude = original_start_location.latitude + 0.000315;
          temp_location.coords.longitude = original_start_location.longitude - 0.000315;
          location_index++;
          break;
        case 4:
          temp_location.coords.latitude = original_start_location.latitude + 0.000315;
          temp_location.coords.longitude = original_start_location.longitude + 0.000315;
          location_index++;
          break;
        default:
          location_index = 1;
          break;
      }
      a.SetLocation(temp_location, (error, coordinates) => {
        if (error) {
          logger.error(error);
        } else {
          start_location = {
            latitude: coordinates.latitude,
            longitude: coordinates.longitude,
          };
          logger.log('info', `Searching at ${coordinates.latitude}, ${coordinates.longitude}`)
          a.Heartbeat((hbError, hb) => {
            if (hbError) {
              logger.error(hbError);
              process.exit(3);
            }

            if (!hb || !hb.cells) {
              logger.error('hb or hb.cells undefined - aborting');
            } else {
              logger.log('info', 'Heartbeat received');
              const encounters = {};
              for (let i = hb.cells.length - 1; i >= 0; i--) {
                if (hb.cells[i].WildPokemon[0]) {
                  const wildPokemon = hb.cells[i].WildPokemon;
                  for (let j = wildPokemon.length - 1; j >= 0; j--) {
                    const pokeId = wildPokemon[j].pokemon.PokemonId;
                    const pokemon = a.pokemonlist[parseInt(pokeId, 10) - 1];
                    const position = {
                      latitude: wildPokemon[j].Latitude,
                      longitude: wildPokemon[j].Longitude,
                    };
                    const encounterId = wildPokemon[j].SpawnPointId;
                    encounters[encounterId] = {
                      pokemon,
                      details: wildPokemon[j],
                      position,
                    };
                  }
                }
              }
              const hbPokemon = [];
              _.forEach(encounters, (encounter) => {
                hbPokemon.push(encounter);
              });
              logger.log('info', `Found ${hbPokemon.length} pokemon`);

              if (hbPokemon.length === 0) {
                return;
              }

              const newPokemon = removeKnownPokemon(hbPokemon);
              logger.log('info', `Found ${newPokemon.length} new pokemon`);
              if (newPokemon.length === 0) {
                return;
              }

              const interestingPokemon = removeUninterestingPokemon(newPokemon);
              logger.log('info', `Found ${interestingPokemon.length} interesting pokemon`);
              if (interestingPokemon.length === 0) {
                return;
              }
              sendMessage(interestingPokemon);
            }
          });
        }
      })
    }
    getHeartbeat();
    setInterval(getHeartbeat, 60000);
  });
});

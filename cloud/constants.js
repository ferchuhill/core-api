module.exports = {
  MAX_CONTAINERS_QUANTITY_PER_REQUEST: 20,
  TRANSACTIONS_TYPES: {
    RECOVER: 'RECOVER',
    PICKUP: 'PICKUP',
    PROCESSING: 'PROCESSING',
  },
  CONTAINER_STATUS: {
    RECOVERED: 'RECOVERED',
    PICKED: 'PICKED',
    IN_TRANSIT: 'IN_TRANSIT',
    IN_PROCESS: 'IN_PROCESS',
    COMPLETED: 'COMPLETED',
  },
};

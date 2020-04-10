/* @flow */
const { TransactionService } = require('../services');

const findTransactionById = async (request: Object) => {
  const { user, params } = request;
  const { objectId } = params;
  const transaction = await TransactionService.findTransactionWithDetailsById(objectId, user);
  return transaction.toJSON();
};

module.exports = {
  findTransactionById,
};
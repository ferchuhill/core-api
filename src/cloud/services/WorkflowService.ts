import TransactionService from './TransactionService';
import AccountService from './AccountService';
import ContainerService from './ContainerService';
import NotificationService from './NotificationService';
import RecyclingCenterService from './RecyclingCenterService';
import SecurityService from './SecurityService';
import StockService from './StockService';
import UserService from './UserService';
import WasteTypeService from './WasteTypeService';

import { CONTAINER_STATUS, MAX_CONTAINERS_QUANTITY_PER_REQUEST, TRANSACTIONS_TYPES } from '../constants';

const validateRegisterRecover = (containers: Colmena.ContainerInputType[], addressId: string) => {
  if (!containers) throw new Error('containers is required');
  if (!addressId) throw new Error('addressId is required');
  if (!Array.isArray(containers)) throw new Error('container should be an array');
  const typesMap: Map<string, string> = new Map();
  containers.forEach(({ typeId, qty }) => {
    if (typesMap.has(typeId)) {
      throw new Error(`Waste Type ${typeId} cannot be duplicated on request.`);
    }
    typesMap.set(typeId, typeId);
    if (qty > MAX_CONTAINERS_QUANTITY_PER_REQUEST) {
      throw new Error(
        `Max container quantity per request exceded. Please check your containers data.
        Current max: ${MAX_CONTAINERS_QUANTITY_PER_REQUEST}`,
      );
    }
  });
};

const validateTransferAcceptRejectRequest = (transferRequestTransaction: Parse.Object, user: Parse.User): void => {
  const transactionId: string = transferRequestTransaction.id;
  if (transferRequestTransaction.get('type') !== TRANSACTIONS_TYPES.TRANSFER_REQUEST) {
    throw new Error(`Transaction ${transactionId} is not in ${TRANSACTIONS_TYPES.TRANSFER_REQUEST} status.`);
  }
  if (transferRequestTransaction.get('expiredAt')) {
    throw new Error(`Transaction ${transactionId} expired at ${transferRequestTransaction.get('expiredAt')}.`);
  }
  if (!transferRequestTransaction.get('to').equals(user)) {
    throw new Error('You are not allowed to accept/reject this request.');
  }
};

const validateTransferCancel = (transferRequestTransaction: Parse.Object, user: Parse.User): void => {
  const transactionId: string = transferRequestTransaction.id;
  if (transferRequestTransaction.get('type') !== TRANSACTIONS_TYPES.TRANSFER_REQUEST) {
    throw new Error(`Transaction ${transactionId} is not in ${TRANSACTIONS_TYPES.TRANSFER_REQUEST} status.`);
  }
  if (transferRequestTransaction.get('expiredAt')) {
    throw new Error(`Transaction ${transactionId} expired at ${transferRequestTransaction.get('expiredAt')}.`);
  }
  if (!transferRequestTransaction.get('from').equals(user)) {
    throw new Error('You are not allowed to cancel this request.');
  }
};

const canTransportContainer = async (container: Parse.Object, user: Parse.User): Promise<boolean> => {
  const [isRecycler, isCarrier]: boolean[] = await Promise.all([
    ContainerService.isRecyclerOfContainer(container, user),
    ContainerService.isCarrierOfContainer(container, user),
  ]);
  if (
    !(isRecycler || isCarrier) ||
    // if is container recycler but container is now transferred to another user.
    (isRecycler && container.get('status') === CONTAINER_STATUS.TRANSFERRED)
  ) {
    throw new Error(`Cannot transport container ${container.id}. Please check our security policies.`);
  }
  return true;
};

const validateTransport = async (containers: Parse.Object[], user: Parse.User): Promise<boolean[]> => {
  if (
    // eslint-disable-next-line arrow-body-style
    !containers.every((container) => {
      return [CONTAINER_STATUS.RECOVERED, CONTAINER_STATUS.TRANSFERRED].includes(container.get('status'));
    })
  ) {
    throw new Error(
      `Check containers status. To transport a container, It's has to be in 
      ${CONTAINER_STATUS.RECOVERED} or ${CONTAINER_STATUS.TRANSFERRED} status`,
    );
  }

  return Promise.all(containers.map((container) => canTransportContainer(container, user)));
};

/**
 * Register RECOVER method.
 * Inital point start of colmena recover proccess. It takes an input, wich contains
 * waste type and quantity of containers. It will create a transaction, many transaction details
 * and many container in RECOVERED status for each input.
 *
 * @param {Array} containersInput
 * @param {User} user
 */
const registerRecover = async (
  containersInput: Colmena.ContainerInputType[] = [],
  addressId: string,
  user: Parse.User,
): Promise<Parse.Object> => {
  try {
    validateRegisterRecover(containersInput, addressId);
    const wasteTypes: Map<string, Parse.Object> = await WasteTypeService.getWasteTypesFromIds(
      containersInput.map((c) => c.typeId),
    );
    const address: Parse.Object = await AccountService.findAccountAddressById(addressId);
    const transaction: Parse.Object = await TransactionService.createTransaction({
      from: undefined,
      to: user,
      type: TRANSACTIONS_TYPES.RECOVER,
      reason: undefined,
      fromAddress: {},
      toAddress: address.toJSON(),
      recyclingCenter: undefined,
      relatedTo: undefined,
    });
    const containersSetArray: Array<Parse.Object[]> = await Promise.all(
      containersInput.map(({ typeId, qty }) => {
        const wasteType: Parse.Object | undefined = wasteTypes.get(typeId);
        if (!wasteType) throw new Error('Waste Type not found');
        return ContainerService.createContainersOfType(
          wasteType,
          qty,
          CONTAINER_STATUS.RECOVERED,
          transaction.get('number'),
        );
      }),
    );
    // TODO replace this line by new array flat() method.
    const containers: Parse.Object[] = ([] as Parse.Object[]).concat(...containersSetArray);
    const details: Parse.Object[] = containers.map((container) =>
      TransactionService.createTransactionDetail(transaction, container));


    await Parse.Object.saveAll([transaction, ...containers, ...details], {
      sessionToken: user.getSessionToken(),
    });

    await Promise.all(
      containersInput.map((input) => {
        const wasteType: Parse.Object | undefined = wasteTypes.get(input.typeId);
        if (!wasteType) throw new Error('Waste Type not found');
        return StockService.incrementStock(wasteType, user, input.qty);
      }),
    );
    transaction.set(
      'details',
      details.map((d) => d.toJSON()),
    );
    return transaction;
  } catch (error) {
    throw new Error(`Transaction could not be registered. Detail: ${error.message}`);
  }
};

/**
 * Transfer Request method. It accept a container ids array and then generates one Transaction
 * along with many transactions details for each container. Each container status is changed to
 * TRANSFER_PENDING status. No stock movements are generated here.
 *
 * @param {Array} containersInput
 * @param {User} to
 * @param {User} user
 */
const registerTransferRequest = async (
  containersInput: string[],
  to: string,
  user: Parse.User,
): Promise<Parse.Object> => {
  try {
    if (!to) throw new Error("Cannot transfer without a recipient. Please check parameter 'to'");
    const recipient: Parse.User = await UserService.findUserById(to);
    const containers: Parse.Object[] = await Promise.all(
      containersInput.map((containerId) => ContainerService.findContainerById(containerId, user)),
    );
    if (!containers.every((container) => container.get('status') === CONTAINER_STATUS.RECOVERED)) {
      throw new Error(
        `Check containers status. To transfer a container to a user 
        It's has to be in ${CONTAINER_STATUS.RECOVERED} status`,
      );
    }
    const userAccount: Parse.Object = await AccountService.findAccountByUser(user);
    const recipientAccount: Parse.Object = await AccountService.findAccountByUser(recipient);

    const [fromAddress, toAddress]: Parse.Object[] = await Promise.all([
      AccountService.findDefaultAddress(userAccount),
      AccountService.findDefaultAddress(recipientAccount),
    ]);

    const transaction: Parse.Object = await TransactionService.createTransaction({
      from: user,
      to: recipient,
      type: TRANSACTIONS_TYPES.TRANSFER_REQUEST,
      fromAddress: fromAddress.toJSON(),
      toAddress: toAddress.toJSON(),
      reason: undefined,
      recyclingCenter: undefined,
      relatedTo: undefined,
    });

    const details: Parse.Object[] = containers.map((container) => {
      container.set('status', CONTAINER_STATUS.TRANSFER_PENDING);
      return TransactionService.createTransactionDetail(transaction, container);
    });

    await Parse.Object.saveAll([transaction, ...details], {
      sessionToken: user.getSessionToken(),
    });

    await SecurityService.grantReadAndWritePermissionsToUser('Transaction', transaction.id, recipient);
    await Promise.all(
      containers.map((container) =>
        SecurityService.grantReadAndWritePermissionsToUser('Container', container.id, recipient)),
    );
    await NotificationService.notifyTransferRequest(transaction.id, user, recipient);
    transaction.set(
      'details',
      details.map((d) => d.toJSON()),
    );
    return transaction;
  } catch (error) {
    throw new Error(`Transaction could not be registered. Detail: ${error.message}`);
  }
};

/**
 * Transfer Accept method. Receive the Transaction Id for a TRASNFER_REQUEST given.
 * Verifies if transaction is valid and then creates a new Transaction and detail for the operation.
 * Each container in the request is set to TRANSFERRED status. Also, move the stock from the owner
 * to the user that request the endpoint.
 *
 * @param {Array} containersInput
 * @param {User} to
 * @param {User} user
 */
const registerTransferAccept = async (transactionId: string, user: Parse.User): Promise<Parse.Object> => {
  try {
    const transferRequestTransaction: Parse.Object = await TransactionService.findRawTransaction(transactionId, user);
    const from = transferRequestTransaction.get('from');
    const to = transferRequestTransaction.get('to');
    validateTransferAcceptRejectRequest(transferRequestTransaction, user);
    const transaction: Parse.Object = await TransactionService.createTransaction({
      from,
      to,
      type: TRANSACTIONS_TYPES.TRANSFER_ACCEPT,
      fromAddress: transferRequestTransaction.get('fromAddress'),
      toAddress: transferRequestTransaction.get('toAddress'),
      relatedTo: undefined,
      reason: undefined,
      recyclingCenter: undefined,
    });
    transaction.set('relatedTo', transferRequestTransaction);
    transferRequestTransaction.set('expiredAt', new Date());

    const containers: Parse.Object[] = await ContainerService.findContainersByTransaction(transferRequestTransaction);
    const details: Parse.Object[] = containers.map((container) => {
      container.set('status', CONTAINER_STATUS.TRANSFERRED);
      return TransactionService.createTransactionDetail(transaction, container);
    });

    await Parse.Object.saveAll([transaction, ...details], {
      sessionToken: user.getSessionToken(),
    });
    await Promise.all(containers.map((container) => StockService.moveStock(container.get('type'), from, to, 1)));

    transaction.set(
      'details',
      details.map((d) => d.toJSON()),
    );
    return transaction;
  } catch (error) {
    throw new Error(`Transaction could not be registered. Detail: ${error.message}`);
  }
};

const registerTransferReject = async (transactionId: string, reason: string, user: Parse.User): Promise<Parse.Object> => {
  try {
    const transferRequestTransaction: Parse.Object = await TransactionService.findRawTransaction(transactionId, user);
    validateTransferAcceptRejectRequest(transferRequestTransaction, user);

    const transaction: Parse.Object = await TransactionService.createTransaction({
      from: transferRequestTransaction.get('from'),
      to: transferRequestTransaction.get('to'),
      type: TRANSACTIONS_TYPES.TRANSFER_REJECT,
      reason,
      fromAddress: transferRequestTransaction.get('fromAddress'),
      toAddress: transferRequestTransaction.get('toAddress'),
      relatedTo: undefined,
      recyclingCenter: undefined,
    });
    transaction.set('relatedTo', transferRequestTransaction);
    transferRequestTransaction.set('expiredAt', new Date());

    const containers: Parse.Object[] = await ContainerService.findContainersByTransaction(transferRequestTransaction);
    const details: Parse.Object[] = containers.map((container) => {
      container.set('status', CONTAINER_STATUS.RECOVERED);
      return TransactionService.createTransactionDetail(transaction, container);
    });

    await Parse.Object.saveAll([transaction, ...details], {
      sessionToken: user.getSessionToken(),
    });

    transaction.set(
      'details',
      details.map((d) => d.toJSON()),
    );
    return transaction;
  } catch (error) {
    throw new Error(`Transaction could not be registered. Detail: ${error.message}`);
  }
};

const registerTransferCancel = async (transactionId: string, user: Parse.User): Promise<Parse.Object> => {
  try {
    const transferRequestTransaction: Parse.Object = await TransactionService.findRawTransaction(transactionId, user);
    validateTransferCancel(transferRequestTransaction, user);
    const transaction: Parse.Object = await TransactionService.createTransaction({
      from: transferRequestTransaction.get('from'),
      to: transferRequestTransaction.get('to'),
      type: TRANSACTIONS_TYPES.TRANSFER_CANCEL,
      reason: undefined,
      recyclingCenter: undefined,
      fromAddress: transferRequestTransaction.get('fromAddress'),
      toAddress: transferRequestTransaction.get('toAddress'),
      relatedTo: undefined,
    });
    transaction.set('relatedTo', transferRequestTransaction);
    transferRequestTransaction.set('expiredAt', new Date());

    const containers: Parse.Object[] = await ContainerService.findContainersByTransaction(transferRequestTransaction);

    const details: Parse.Object[] = containers.map((container) => {
      container.set('status', CONTAINER_STATUS.RECOVERED);
      return TransactionService.createTransactionDetail(transaction, container);
    });

    await Parse.Object.saveAll([transaction, ...details], {
      sessionToken: user.getSessionToken(),
    });

    await Promise.all(
      containers.map((container) =>
        SecurityService.revokeReadAndWritePermissionsToUser(
          'Container',
          container.id,
          transferRequestTransaction.get('to'),
        )),
    );
    transaction.set(
      'details',
      details.map((d) => d.toJSON()),
    );
    return transaction;
  } catch (error) {
    throw new Error(`Transaction could not be registered. Detail: ${error.message}`);
  }
};

/**
 * Register Transport. Receive an array of containers ids.
 * Verifies if containers are in RECOVERED or TRANSFERRED status and then check if the user can transport it.
 * Creates one transaction, many details for each container and changes containers status to IN_TRANSIT.
 * Then notifies to all the user involved except the user that request the endpoint.
 *
 * @param {Array} containersInput
 * @param {User} to
 * @param {User} user
 */
const registerTransport = async (containersInput: string[], to: string, user: Parse.User): Promise<Parse.Object> => {
  try {
    if (!to) throw new Error("Cannot transfer without a destination. Please check parameter 'to'");
    const recyclingCenter: Parse.Object = await RecyclingCenterService.findRecyclingCenterById(to);
    const containers: Parse.Object[] = await Promise.all(
      containersInput.map((containerId) => ContainerService.findContainerById(containerId, user)),
    );

    await validateTransport(containers, user);

    const userAccount = await AccountService.findAccountByUser(user);
    const fromAddress: Parse.Object = await AccountService.findDefaultAddress(userAccount);

    const transaction: Parse.Object = await TransactionService.createTransaction({
      to: undefined,
      from: user,
      type: TRANSACTIONS_TYPES.TRANSPORT,
      recyclingCenter,
      reason: undefined,
      fromAddress: fromAddress.toJSON(),
      toAddress: recyclingCenter.get('latLng'),
      relatedTo: undefined,
    });

    const details: Parse.Object[] = containers.map((container) => {
      container.set('status', CONTAINER_STATUS.IN_TRANSIT);
      return TransactionService.createTransactionDetail(transaction, container);
    });

    await Parse.Object.saveAll([transaction, ...details], {
      sessionToken: user.getSessionToken(),
    });

    // get containers owners except user that request the endpoint
    const usersList: Parse.User[] = containers.map((c) => c.get('createdBy')).filter((u) => !u.equals(user));
    await NotificationService.notifyTransport(transaction.id, user, usersList);
    transaction.set(
      'details',
      details.map((d) => d.toJSON()),
    );
    return transaction;
  } catch (error) {
    throw new Error(`Transaction could not be registered. Detail: ${error.message}`);
  }
};

export default {
  registerRecover,
  registerTransferRequest,
  registerTransferAccept,
  registerTransferReject,
  registerTransferCancel,
  registerTransport,
};
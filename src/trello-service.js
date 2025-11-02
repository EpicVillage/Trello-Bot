const Trello = require('trello');

class TrelloService {
    constructor(apiKey, token) {
        this.trello = new Trello(apiKey, token);
        this.cache = {
            boards: null,
            lists: {},
            lastUpdate: null
        };
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    }

    async getBoards() {
        if (this.cache.boards && this.cache.lastUpdate && 
            Date.now() - this.cache.lastUpdate < this.cacheTimeout) {
            return this.cache.boards;
        }

        try {
            const boards = await this.trello.getBoards('me');
            this.cache.boards = boards.filter(board => !board.closed);
            this.cache.lastUpdate = Date.now();
            return this.cache.boards;
        } catch (error) {
            console.error('Error fetching boards:', error);
            throw new Error('Failed to fetch Trello boards');
        }
    }

    async getBoardLists(boardId) {
        // Always fetch fresh list data to reflect Trello changes
        try {
            const lists = await this.trello.getListsOnBoard(boardId);
            this.cache.lists[boardId] = lists.filter(list => !list.closed);
            return this.cache.lists[boardId];
        } catch (error) {
            console.error('Error fetching lists:', error);
            throw new Error('Failed to fetch board lists');
        }
    }

    async createCard(listId, name, desc = '', options = {}) {
        try {
            const cardData = {
                name,
                desc,
                pos: 'top',
                ...options
            };

            const card = await this.trello.addCard(name, desc, listId);
            return card;
        } catch (error) {
            console.error('Error creating card:', error);
            throw new Error('Failed to create Trello card');
        }
    }

    async createCardWithDetails(listId, cardData) {
        try {
            const { name, desc, labels, members, due, checklist } = cardData;
            
            const card = await this.trello.addCard(name, desc, listId);
            
            if (labels && labels.length > 0) {
                for (const labelId of labels) {
                    await this.trello.addLabelToCard(card.id, labelId);
                }
            }

            if (members && members.length > 0) {
                for (const memberId of members) {
                    await this.trello.addMemberToCard(card.id, memberId);
                }
            }

            if (due) {
                await this.trello.updateCard(card.id, 'due', due);
            }

            if (checklist && checklist.length > 0) {
                const checklistObj = await this.trello.addChecklistToCard(card.id, 'Tasks');
                for (const item of checklist) {
                    await this.trello.addItemToChecklist(checklistObj.id, item);
                }
            }

            return card;
        } catch (error) {
            console.error('Error creating detailed card:', error);
            throw new Error('Failed to create card with details');
        }
    }

    async getBoardMembers(boardId) {
        try {
            const members = await this.trello.getBoardMembers(boardId);
            return members;
        } catch (error) {
            console.error('Error fetching board members:', error);
            throw new Error('Failed to fetch board members');
        }
    }

    async getBoardLabels(boardId) {
        try {
            const labels = await this.trello.getLabelsForBoard(boardId);
            return labels;
        } catch (error) {
            console.error('Error fetching board labels:', error);
            throw new Error('Failed to fetch board labels');
        }
    }

    async getListCards(listId, includeCompleted = false) {
        try {
            const cards = await this.trello.getCardsOnList(listId);
            // Filter out closed cards and optionally completed cards
            return cards.filter(card => {
                // Always exclude closed/archived cards
                if (card.closed) return false;
                
                // Exclude cards marked as complete (dueComplete = true) unless specifically requested
                if (!includeCompleted && card.dueComplete === true) return false;
                
                return true;
            });
        } catch (error) {
            console.error('Error fetching list cards:', error);
            throw new Error('Failed to fetch cards from list');
        }
    }

    async getCard(cardId) {
        try {
            // Make sure cardId is a string, not an object
            const id = typeof cardId === 'object' ? cardId.id : cardId;
            const card = await this.trello.getCard(id, 'all');
            return card;
        } catch (error) {
            console.error('Error fetching card:', error);
            throw new Error('Failed to fetch card details');
        }
    }

    async getCardComments(cardId) {
        try {
            const actions = await this.trello.makeRequest('get', `/1/cards/${cardId}/actions`, {
                filter: 'commentCard'
            });
            return actions;
        } catch (error) {
            console.error('Error fetching card comments:', error);
            return [];
        }
    }

    async getCardChecklists(cardId) {
        try {
            const checklists = await this.trello.getChecklistsOnCard(cardId);
            return checklists;
        } catch (error) {
            console.error('Error fetching card checklists:', error);
            return [];
        }
    }

    async searchCards(boardId, query) {
        try {
            const cards = await this.trello.searchCards(query, {
                idBoards: boardId,
                modelTypes: 'cards',
                card_fields: 'name,desc,url,dateLastActivity',
                cards_limit: 10
            });
            return cards;
        } catch (error) {
            console.error('Error searching cards:', error);
            throw new Error('Failed to search cards');
        }
    }

    async moveCard(cardId, newListId) {
        try {
            const result = await this.trello.updateCard(cardId, 'idList', newListId);
            return result;
        } catch (error) {
            console.error('Error moving card:', error);
            throw new Error('Failed to move card');
        }
    }

    async archiveCard(cardId) {
        try {
            const result = await this.trello.updateCard(cardId, 'closed', true);
            return result;
        } catch (error) {
            console.error('Error archiving card:', error);
            throw new Error('Failed to archive card');
        }
    }

    clearCache() {
        this.cache = {
            boards: null,
            lists: {},
            lastUpdate: null
        };
    }
}

module.exports = TrelloService;
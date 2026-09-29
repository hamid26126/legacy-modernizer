$(document).ready(function () {

  var showingCompletedOnly = false;

  function updateStats() {
    var total = 0;
    var completed = 0;

    $('#task-list li').each(function () {
      total++;
      if ($(this).hasClass('completed')) {
        completed++;
      }
    });

    $('#stats').text('Total: ' + total + ' | Completed: ' + completed + ' | Remaining: ' + (total - completed));
  }

  function appendTask(title, taskId, isCompleted) {
    var checkbox = '<input type="checkbox" class="task-checkbox">';
    if (isCompleted) {
      checkbox = '<input type="checkbox" class="task-checkbox" checked>';
    }

    var li = $(
      '<li>' +
        checkbox +
        '<span class="task-text">' + title + '</span>' +
        '<button class="delete-btn">Delete</button>' +
      '</li>'
    );

    li.data('taskId', taskId);

    if (isCompleted) {
      li.addClass('completed');
    }

    if (showingCompletedOnly && !isCompleted) {
      li.hide();
    }

    $('#task-list').append(li);
    updateStats();
  }

  $('#add-btn').on('click', function () {
    var val = $.trim($('#task-input').val());
    if (val === '') {
      return;
    }

    var taskId = 'local-' + Date.now();
    appendTask(val, taskId, false);
    $('#task-input').val('');
  });

  $('#task-list').on('click', '.delete-btn', function () {
    $(this).closest('li').remove();
    updateStats();
  });

  $('#task-list').on('change', '.task-checkbox', function () {
    var $li = $(this).closest('li');
    $li.toggleClass('completed', $(this).is(':checked'));

    if (showingCompletedOnly && !$li.hasClass('completed')) {
      $li.hide();
    } else if (!showingCompletedOnly) {
      $li.show();
    }

    updateStats();
  });

  $('#toggle-completed').on('click', function () {
    showingCompletedOnly = !showingCompletedOnly;
    $(this).text(showingCompletedOnly ? 'Show all' : 'Show completed only');

    if (showingCompletedOnly) {
      $('#task-list li').each(function () {
        if ($(this).hasClass('completed')) {
          $(this).show();
        } else {
          $(this).hide();
        }
      });
    } else {
      $('#task-list li').show();
    }
  });

  $('#clear-completed').on('click', function () {
    $('#task-list li.completed').remove();
    updateStats();
  });

  $.ajax({
    url: 'https://jsonplaceholder.typicode.com/todos?_limit=3',
    method: 'GET',
    success: function (data) {
      $.each(data, function (i, item) {
        appendTask(item.title, item.id, item.completed);
      });
    }
  });

});

classdef A < handle
    methods
        function obj = A()
        end
    end
    methods (Static)
        function s = make()
            s = 1;
        end
    end
    methods (Access = private)
        function hidden(obj)
        end
    end
    methods (Hidden)
        function tucked(obj)
        end
    end
end
